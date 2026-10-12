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

let changes = 0;

function build(id: number, status: string, result: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    status,
    lastChangedDate: new Date(Date.UTC(2026, 0, 1, 0, 0, ++changes)).toISOString(),
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
  const fatal: unknown[] = [];
  const poller = new AzureDevOpsPoller({
    organizationUrl: ORG,
    repositories: ['proj/repo'],
    token: 'pat',
    intervalMs: INTERVAL,
    onError: (e) => errors.push(e),
    onFatal: (e) => fatal.push(e),
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
  return { emitted, requests, errors, fatal, controller, poll };
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

  it('reports a retried build, which keeps its build id', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: { value: [pr(7, OLD)] } } };
    quiet(routes, [7, OLD]);
    const at = (minute: number) => ({ lastChangedDate: `2026-01-01T00:0${minute}:00Z` });
    routes[buildsUrl(7)] = { body: { value: [build(11, 'inProgress', null, at(1))] } };
    const { emitted, poll } = started(routes);
    await poll();
    routes[buildsUrl(7)] = { body: { value: [build(11, 'completed', 'failed', at(2))] } };
    await poll();
    routes[buildsUrl(7)] = { body: { value: [build(11, 'inProgress', null, at(3))] } };
    await poll();
    routes[buildsUrl(7)] = { body: { value: [build(11, 'completed', 'succeeded', at(4))] } };
    await poll();

    expect(ciData(emitted).map((d) => d.to)).toEqual(['running', 'failure', 'running', 'success']);
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

  it('stops polling when a PAT is answered with a sign-in page or a 401', async () => {
    for (const response of [
      () => new Response('<html>sign in</html>', { status: 203, headers: { 'content-type': 'text/html' } }),
      () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }),
    ]) {
      const fetch = vi.fn(async () => response());
      const { fatal, errors, poll } = started({}, { fetch: fetch as unknown as typeof globalThis.fetch });

      await poll();
      await poll();

      expect(String(fatal[0])).toContain('rejected the credential');
      expect(errors).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  describe('with the Azure CLI', () => {
    const azToken = (accessToken: string, expiresInS: number) =>
      JSON.stringify({ accessToken, expires_on: Math.floor(Date.now() / 1000) + expiresInS, tokenType: 'Bearer' });

    it('sends the az token as a Bearer token and asks az again shortly before it expires', async () => {
      const routes: Record<string, Route> = { [pullsUrl]: { body: { value: [] } } };
      const tokens = ['one', 'two'];
      const runAzureCli = vi.fn(async (args: readonly string[]) => {
        expect(args).toEqual(['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '--output', 'json']);
        return azToken(tokens.shift()!, 3_600);
      });
      const { requests, poll } = started(routes, { token: undefined, azureCli: true, runAzureCli });

      await poll();
      await poll();
      expect(runAzureCli).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(56 * 60_000);
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);

      expect(runAzureCli).toHaveBeenCalledTimes(2);
      expect(requests[0]!.headers.authorization).toBe('Bearer one');
      expect(requests.at(-1)!.headers.authorization).toBe('Bearer two');
    });

    it('asks az for a new token once when the host rejects one, and stops if that is rejected too', async () => {
      const runAzureCli = vi.fn(async () => azToken('t', 3_600));
      let answers = [401, 200];
      const fetch = vi.fn(async () => {
        const status = answers.shift() ?? 401;
        return new Response(JSON.stringify({ value: [] }), { status, headers: { 'content-type': 'application/json' } });
      });
      const { fatal, poll } = started({}, { token: undefined, azureCli: true, runAzureCli, fetch: fetch as unknown as typeof globalThis.fetch });

      await poll();
      expect(fatal).toEqual([]);
      expect(runAzureCli).toHaveBeenCalledTimes(2);

      answers = [401, 401];
      await poll();
      expect(String(fatal[0])).toContain('rejected the credential');
    });

    it('stops polling when az fails, saying to sign in', async () => {
      const runAzureCli = vi.fn(async () => { throw new Error('Please run az login'); });
      const { fatal, poll } = started({}, { token: undefined, azureCli: true, runAzureCli });

      await poll();

      expect(String(fatal[0])).toContain('az login');
    });
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
    expect(() => new AzureDevOpsPoller({ ...base, token: undefined })).toThrow('exactly one');
    expect(() => new AzureDevOpsPoller({ ...base, azureCli: true })).toThrow('exactly one');
    expect(() => new AzureDevOpsPoller({ ...base, organizationUrl: 'not a url' })).toThrow('URL');
    expect(() => new AzureDevOpsPoller({ ...base, repositories: ['repo'] })).toThrow('project/repository');
  });
});
