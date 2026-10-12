import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayEvent } from '../src/contract';
import { CI_STATUS_CHANGED, PR_CLOSED, PR_HEAD_CHANGED } from '../src/kinds/index';
import { GitHubPoller, type GitHubPollerOptions } from '../src/sources/github/index';
import { RateLimited } from '../src/sources/scm/poll';
import { ScmSource } from '../src/sources/scm/index';

const API = 'https://api.github.com';
const OLD = 'b'.repeat(40);
const NEW = 'c'.repeat(40);
const REPO = { full_name: 'o/r', html_url: 'https://github.com/o/r' };

function pull(number: number, sha: string, extra: Record<string, unknown> = {}) {
  return {
    number,
    state: 'open',
    head: { sha },
    base: { repo: REPO },
    html_url: `https://github.com/o/r/pull/${number}`,
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: null,
    merged_at: null,
    ...extra,
  };
}

function checkRun(id: number, sha: string, status: string, conclusion: string | null = null) {
  return { id, name: 'build', head_sha: sha, status, conclusion, html_url: null, started_at: null, completed_at: null };
}

interface Route {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fake GitHub: `routes` maps a URL to what it answers. Each answer carries an ETag derived from its body. */
function fakeGitHub(routes: Record<string, Route>) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url, headers });
    const route = routes[url] ?? { status: 404, body: { message: 'Not Found' } };
    const body = JSON.stringify(route.body ?? null);
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    if (headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(body, { status: route.status ?? 200, headers: { etag, ...route.headers } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests, routes };
}

function noChecks(routes: Record<string, Route>, ...shas: string[]): void {
  for (const sha of shas) {
    routes[`${API}/repos/o/r/commits/${sha}/check-runs?per_page=100`] = { body: { check_runs: [] } };
    routes[`${API}/repos/o/r/commits/${sha}/status?per_page=100`] = { body: { statuses: [] } };
  }
}

const INTERVAL = 1_000;

// Runs the poller behind a real ScmSource. The first poll runs on start; `poll` waits for the next one.
function started(routes: Record<string, Route>, options: Partial<GitHubPollerOptions> = {}) {
  const github = fakeGitHub(routes);
  const errors: unknown[] = [];
  const poller = new GitHubPoller({ token: 't', repositories: ['o/r'], fetch: github.fetch, intervalMs: INTERVAL, onError: (e) => errors.push(e), ...options });
  const emitted: RelayEvent[] = [];
  const controller = new AbortController();
  void new ScmSource(poller).start({ emit: (e) => emitted.push(e), signal: controller.signal });
  let first = true;
  const poll = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(first ? 0 : INTERVAL);
    first = false;
    // A pass is a chain of awaited fetches; let it finish before the test looks.
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
  };
  return { emitted, github, controller, errors, poll };
}

const pullsUrl = `${API}/repos/o/r/pulls?state=open&per_page=100`;

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

describe('GitHubPoller', () => {
  it('does not report PRs already open when polling starts, but reports their CI', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: [pull(7, OLD)] } };
    noChecks(routes, OLD);
    routes[`${API}/repos/o/r/commits/${OLD}/check-runs?per_page=100`] = { body: { check_runs: [checkRun(1, OLD, 'in_progress')] } };
    const { poll, emitted } = started(routes);

    await poll();

    expect(emitted.map((e) => [e.kind, e.subject.key, (e.data as { to: unknown }).to])).toEqual([
      [CI_STATUS_CHANGED, `github.com/o/r@${OLD}`, 'running'],
    ]);
  });

  it('reports a moved head with the previous head, and a new PR as opened', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: [pull(7, OLD)] } };
    noChecks(routes, OLD, NEW);
    const { poll, emitted } = started(routes);
    await poll();

    routes[pullsUrl] = { body: [pull(7, NEW), pull(8, OLD)] };
    await poll();

    expect(emitted.map((e) => [e.kind, e.subject.key, e.data])).toEqual([
      [PR_HEAD_CHANGED, 'github.com/o/r#7', { repository: 'github.com/o/r', number: 7, from: OLD, to: NEW, url: 'https://github.com/o/r/pull/7' }],
      [PR_HEAD_CHANGED, 'github.com/o/r#8', { repository: 'github.com/o/r', number: 8, from: null, to: OLD, url: 'https://github.com/o/r/pull/8' }],
    ]);
  });

  it('reports a PR that left the open list as closed, once', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: [pull(7, OLD)] } };
    noChecks(routes, OLD);
    const { poll, emitted } = started(routes);
    await poll();

    routes[pullsUrl] = { body: [] };
    routes[`${API}/repos/o/r/pulls/7`] = { body: pull(7, OLD, { state: 'closed', closed_at: '2026-01-02T00:00:00Z', merged_at: '2026-01-02T00:00:00Z' }) };
    await poll();
    await poll();

    expect(emitted.map((e) => [e.kind, e.data])).toEqual([
      [PR_CLOSED, { repository: 'github.com/o/r', number: 7, merged: true, head: OLD, url: 'https://github.com/o/r/pull/7' }],
    ]);
  });

  it('retries a close it could not read on the next poll', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: [pull(7, OLD)] } };
    noChecks(routes, OLD);
    const { poll, emitted, errors } = started(routes);
    await poll();

    routes[pullsUrl] = { body: [] };
    routes[`${API}/repos/o/r/pulls/7`] = { status: 502, body: {} };
    await poll();
    expect(String(errors[0])).toContain('HTTP 502');
    routes[`${API}/repos/o/r/pulls/7`] = { body: pull(7, OLD, { state: 'closed', closed_at: '2026-01-02T00:00:00Z' }) };
    await poll();

    expect(emitted.map((e) => [e.kind, (e.data as { merged: boolean }).merged])).toEqual([[PR_CLOSED, false]]);
  });

  it('reports a re-run of a check after the run it replaced', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: [pull(7, OLD)] } };
    noChecks(routes, OLD);
    routes[`${API}/repos/o/r/commits/${OLD}/check-runs?per_page=100`] = {
      body: { check_runs: [checkRun(2, OLD, 'in_progress'), checkRun(1, OLD, 'completed', 'failure')] },
    };
    const { poll, emitted } = started(routes);

    await poll();

    expect(emitted.map((e) => (e.data as { to: unknown }).to)).toEqual(['failure', 'running']);
  });

  it('reports commit statuses on the head', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: [pull(7, OLD)] } };
    noChecks(routes, OLD);
    routes[`${API}/repos/o/r/commits/${OLD}/status?per_page=100`] = {
      body: { statuses: [{ id: 5, state: 'success', context: 'ci/legacy', target_url: null, updated_at: '2026-01-01T00:00:00Z' }] },
    };
    const { poll, emitted } = started(routes);

    await poll();

    expect(emitted.map((e) => [e.subject.key, (e.data as { check: string }).check, e.untrusted.name, (e.data as { to: unknown }).to])).toEqual([
      [`github.com/o/r@${OLD}`, 'status', 'ci/legacy', 'success'],
    ]);
  });

  it('sends conditional requests and reports nothing new when GitHub answers 304', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: [pull(7, OLD)] } };
    noChecks(routes, OLD);
    routes[`${API}/repos/o/r/commits/${OLD}/check-runs?per_page=100`] = { body: { check_runs: [checkRun(1, OLD, 'queued')] } };
    const { poll, emitted, github } = started(routes);

    await poll();
    const firstPollRequests = github.requests.length;
    await poll();

    const second = github.requests.slice(firstPollRequests);
    expect(second.length).toBe(firstPollRequests);
    expect(second.every((r) => r.headers['if-none-match'] !== undefined)).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it('follows Link pagination', async () => {
    const page2 = `${API}/repositories/1/pulls?state=open&per_page=100&page=2`;
    const routes: Record<string, Route> = {
      [pullsUrl]: { body: [pull(7, OLD)], headers: { link: `<${page2}>; rel="next", <${page2}>; rel="last"` } },
      [page2]: { body: [pull(8, NEW)] },
    };
    noChecks(routes, OLD, NEW);
    const { poll, emitted } = started(routes);
    await poll();

    routes[pullsUrl] = { body: [pull(7, OLD)] };
    routes[`${API}/repos/o/r/pulls/8`] = { body: pull(8, NEW, { state: 'closed', closed_at: '2026-01-02T00:00:00Z' }) };
    await poll();

    expect(emitted.map((e) => e.subject.key)).toEqual(['github.com/o/r#8']);
  });

  it('stops the poll and waits as long as GitHub asks when rate limited', async () => {
    const routes: Record<string, Route> = {
      [pullsUrl]: { status: 403, body: {}, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '120' } },
    };
    const { github, controller, errors } = started(routes);

    await vi.advanceTimersByTimeAsync(0);
    expect(errors[0]).toBeInstanceOf(RateLimited);
    expect((errors[0] as RateLimited).retryAfterMs).toBe(120_000);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(github.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(github.requests).toHaveLength(2);
    controller.abort();
  });

  it('keeps polling the other repositories when one fails', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: [pull(7, OLD)] } };
    noChecks(routes, OLD, NEW);
    const { poll, emitted, errors } = started(routes, { repositories: ['o/missing', 'o/r'] });
    await poll();

    routes[pullsUrl] = { body: [pull(7, NEW)] };
    await poll();

    expect(emitted.map((e) => e.kind)).toEqual([PR_HEAD_CHANGED]);
    expect(errors.map(String)).toEqual([expect.stringContaining('HTTP 404'), expect.stringContaining('HTTP 404')]);
  });

  it('stops polling when the relay stops it', async () => {
    const routes: Record<string, Route> = { [pullsUrl]: { body: [] } };
    const { github, controller } = started(routes);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(github.requests).toHaveLength(1);
  });

  it('refuses an empty token and names that are not owner/repo', () => {
    expect(() => new GitHubPoller({ token: '', repositories: [] })).toThrow('token');
    expect(() => new GitHubPoller({ token: 't', repositories: ['o/r/extra'] })).toThrow('owner/repo');
  });
});
