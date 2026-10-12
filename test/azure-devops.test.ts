import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayEvent } from '../src/contract';
import { CI_STATUS_CHANGED, PR_CLOSED, PR_HEAD_CHANGED, type CiStatusChanged } from '../src/kinds/index';
import { AzureDevOpsPoller, type AzureDevOpsPollerOptions } from '../src/sources/azure-devops/index';
import { RateLimited } from '../src/sources/scm/poll';
import { ScmSource } from '../src/sources/scm/index';

const ORG = 'https://dev.azure.com/org';
const GIT = `${ORG}/proj/_apis/git/repositories/repo`;
const REPOSITORY = 'dev.azure.com/org/proj/_git/repo';
const OLD = 'b'.repeat(40);
const NEW = 'c'.repeat(40);
const MERGE = 'm'.repeat(40);
const INTERVAL = 1_000;

const pullsUrl = `${GIT}/pullrequests?searchCriteria.status=active&$top=100&$skip=0&api-version=7.1`;
const buildsUrl = (number: number) =>
  `${ORG}/proj/_apis/build/builds?branchName=${encodeURIComponent(`refs/pull/${number}/merge`)}&queryOrder=queueTimeDescending&$top=50&api-version=7.1`;
const statusesUrl = (sha: string) => `${GIT}/commits/${sha}/statuses?latestOnly=true&api-version=7.1`;

function pr(number: number, sha: string, extra: Record<string, unknown> = {}) {
  return { pullRequestId: number, status: 'active', lastMergeSourceCommit: { commitId: sha }, lastMergeCommit: { commitId: MERGE }, ...extra };
}

function build(id: number, status: string, result: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    status,
    ...(result === null ? {} : { result }),
    definition: { name: 'ci' },
    sourceVersion: MERGE,
    _links: { web: { href: `${ORG}/proj/_build/results?buildId=${id}` } },
    ...extra,
  };
}

interface Route {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function started(routes: Record<string, Route>, options: Partial<AzureDevOpsPollerOptions> = {}) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[url] ?? { status: 404, body: { message: 'not found' } };
    return new Response(JSON.stringify(route.body ?? null), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json; charset=utf-8', ...route.headers },
    });
  });
  const errors: unknown[] = [];
  const poller = new AzureDevOpsPoller({
    organizationUrl: ORG,
    repositories: ['proj/repo'],
    token: 'pat',
    intervalMs: INTERVAL,
    onError: (e) => errors.push(e),
    fetch: fetch as unknown as typeof globalThis.fetch,
    ...options,
  });
  const emitted: RelayEvent[] = [];
  const controller = new AbortController();
  void new ScmSource(poller).start({ emit: (e) => emitted.push(e), signal: controller.signal });
  let first = true;
  const poll = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(first ? 0 : INTERVAL);
    first = false;
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
  };
  return { emitted, requests, errors, controller, poll };
}

function quiet(routes: Record<string, Route>, ...prs: [number, string][]): void {
  for (const [number, sha] of prs) {
    routes[buildsUrl(number)] = { body: { value: [] } };
    routes[statusesUrl(sha)] = { body: { value: [] } };
  }
}

const ciData = (events: RelayEvent[]) => events.filter((e) => e.kind === CI_STATUS_CHANGED).map((e) => e.data as CiStatusChanged);

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

describe('AzureDevOpsPoller', () => {
  it('authenticates with the PAT and names repositories by host and path', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: { value: [pr(7, OLD)] } } };
    quiet(routes, [7, OLD]);
    routes[statusesUrl(OLD)] = { body: { value: [{ id: 1, state: 'succeeded', context: { name: 'lint', genre: 'tools' }, targetUrl: null }] } };
    const { emitted, requests, poll } = started(routes);

    await poll();

    expect(requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from(':pat').toString('base64')}`);
    expect(emitted.map((e) => [e.subject.key, e.untrusted.name, (e.data as CiStatusChanged).to])).toEqual([[`${REPOSITORY}@${OLD}`, 'tools/lint', 'success']]);
  });

  it('reports a moved head and a new PR after the first poll, not the PRs already open', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: { value: [pr(7, OLD)] } } };
    quiet(routes, [7, OLD], [7, NEW], [8, OLD]);
    const { emitted, poll } = started(routes);
    await poll();

    routes[pullsUrl] = { body: { value: [pr(7, NEW), pr(8, OLD)] } };
    await poll();

    expect(emitted.map((e) => [e.kind, e.data])).toEqual([
      [PR_HEAD_CHANGED, { repository: REPOSITORY, number: 7, from: OLD, to: NEW, url: `${ORG}/proj/_git/repo/pullrequest/7` }],
      [PR_HEAD_CHANGED, { repository: REPOSITORY, number: 8, from: null, to: OLD, url: `${ORG}/proj/_git/repo/pullrequest/8` }],
    ]);
  });

  it('reports completed as merged and abandoned as closed without merging', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: { value: [pr(7, OLD), pr(8, NEW)] } } };
    quiet(routes, [7, OLD], [8, NEW]);
    const { emitted, poll } = started(routes);
    await poll();

    routes[pullsUrl] = { body: { value: [] } };
    routes[`${GIT}/pullrequests/7?api-version=7.1`] = { body: pr(7, OLD, { status: 'completed', closedDate: '2026-01-02T00:00:00Z' }) };
    routes[`${GIT}/pullrequests/8?api-version=7.1`] = { body: pr(8, NEW, { status: 'abandoned', closedDate: '2026-01-03T00:00:00Z' }) };
    await poll();
    await poll();

    expect(emitted.map((e) => [e.kind, e.subject.key, (e.data as { merged: boolean }).merged])).toEqual([
      [PR_CLOSED, `${REPOSITORY}#7`, true],
      [PR_CLOSED, `${REPOSITORY}#8`, false],
    ]);
  });

  it('reports a PR build on the PR head, not the merge commit it built', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: { value: [pr(7, OLD)] } } };
    quiet(routes, [7, OLD]);
    routes[buildsUrl(7)] = { body: { value: [build(11, 'inProgress', null)] } };
    const { emitted, poll } = started(routes);
    await poll();

    routes[buildsUrl(7)] = { body: { value: [build(11, 'completed', 'partiallySucceeded')] } };
    await poll();

    expect(ciData(emitted)).toEqual([
      expect.objectContaining({ sha: OLD, check: 'build', from: null, to: 'running', detail: 'inProgress' }),
      expect.objectContaining({ sha: OLD, check: 'build', from: 'running', to: 'failure', detail: 'partiallySucceeded' }),
    ]);
  });

  it('uses triggerInfo pr.sourceSha when the pipeline reports it, and skips a build it cannot place', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: { value: [pr(7, NEW)] } } };
    quiet(routes, [7, NEW]);
    routes[buildsUrl(7)] = {
      body: {
        value: [
          build(10, 'completed', 'failed', { sourceVersion: 'x'.repeat(40), triggerInfo: { 'pr.sourceSha': OLD } }),
          build(11, 'completed', 'succeeded', { sourceVersion: 'y'.repeat(40) }),
        ],
      },
    };
    const { emitted, poll } = started(routes);

    await poll();

    expect(ciData(emitted).map((d) => [d.sha, d.to])).toEqual([[OLD, 'failure']]);
  });

  it('pages through more than 100 active PRs', async () => {
    const first = Array.from({ length: 100 }, (_, i) => pr(i + 1, OLD));
    const routes: Record<string, Route> = {
      [pullsUrl]: { body: { value: first } },
      [`${GIT}/pullrequests?searchCriteria.status=active&$top=100&$skip=100&api-version=7.1`]: { body: { value: [pr(101, OLD)] } },
    };
    for (let n = 1; n <= 101; n++) quiet(routes, [n, OLD]);
    const { requests, poll } = started(routes);

    await poll();

    expect(requests.filter((r) => r.url.includes('/builds?')).length).toBe(101);
  });

  it('waits as long as Azure DevOps asks when throttled', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { status: 429, body: {}, headers: { 'retry-after': '30' } } };
    const { errors, requests, controller, poll } = started(routes);

    await poll();
    expect(errors[0]).toBeInstanceOf(RateLimited);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests).toHaveLength(2);
    controller.abort();
  });

  it('treats a sign-in page instead of JSON as a failed request', async () => {
    const routes: Record<string, Route> = {};
    const { errors, poll } = started(routes, {
      fetch: (async () => new Response('<html>sign in</html>', { status: 203, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch,
    });

    await poll();

    expect(String(errors[0])).toContain('HTTP 203');
  });

  it('names a visualstudio.com organization the same as its dev.azure.com URL', async () => {
    const legacyGit = 'https://org.visualstudio.com/proj/_apis/git/repositories/repo';
    const routes: Record<string, Route> = {
      [`${legacyGit}/pullrequests?searchCriteria.status=active&$top=100&$skip=0&api-version=7.1`]: { body: { value: [pr(7, OLD)] } },
      [`https://org.visualstudio.com/proj/_apis/build/builds?branchName=${encodeURIComponent('refs/pull/7/merge')}&queryOrder=queueTimeDescending&$top=50&api-version=7.1`]: { body: { value: [] } },
      [`${legacyGit}/commits/${OLD}/statuses?latestOnly=true&api-version=7.1`]: { body: { value: [{ id: 1, state: 'pending', context: { name: 'lint' } }] } },
    };
    const { emitted, poll } = started(routes, { organizationUrl: 'https://org.visualstudio.com/' });

    await poll();

    expect(emitted.map((e) => e.subject.key)).toEqual([`${REPOSITORY}@${OLD}`]);
  });

  it('refuses an empty token, a bad URL and names that are not project/repository', () => {
    const base = { organizationUrl: ORG, repositories: [], token: 'pat' };
    expect(() => new AzureDevOpsPoller({ ...base, token: '' })).toThrow('token');
    expect(() => new AzureDevOpsPoller({ ...base, organizationUrl: 'not a url' })).toThrow('URL');
    expect(() => new AzureDevOpsPoller({ ...base, repositories: ['repo'] })).toThrow('project/repository');
  });
});
