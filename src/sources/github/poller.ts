import type { ScmObserver, ScmProvider } from '../scm/provider';
import { ActivityWindow, HttpError, OpenPullRequests, pollEvery, RateLimited, retryAfterMs, runPolling } from '../scm/poll';
import type { ReviewState } from '../../kinds';
import { isObject, num, str, type Json } from '../scm/json';
import { readCiObservation, repositoryId } from './normalize';

export interface GitHubPollerOptions {
  /**
   * A personal access token, sent as a Bearer token. It is expected not to
   * expire: a rejected token stops polling (see `onFatal`).
   */
  token: string;
  /** `owner/repo` names. */
  repositories: readonly string[];
  /** For GitHub Enterprise Server, e.g. "https://ghe.example.com/api/v3". */
  apiUrl?: string;
  intervalMs?: number;
  /** Receives each transient failure (network, 5xx, rate limiting); polling carries on. */
  onError?: (error: unknown) => void;
  /**
   * Receives the failure that stopped polling: a rejected token, a missing
   * repository, anything unexpected, or `maxConsecutiveFailures` transient ones in
   * a row. Without it the failure is thrown as an uncaught exception.
   */
  onFatal?: (error: unknown) => void;
  maxConsecutiveFailures?: number;
  fetch?: typeof fetch;
}

const DEFAULT_API_URL = 'https://api.github.com';
const DEFAULT_INTERVAL_MS = 30_000;
const REPOSITORY_NAME = /^[\w.-]+\/[\w.-]+$/;

interface Cached {
  etag: string;
  body: unknown;
}

/**
 * Polls each repository's open pull requests: the check runs and commit
 * statuses on their heads, their reviews, comments and mergeability. It turns
 * what changed into observations for an ScmSource. Polling instead of webhooks means nothing is lost while the relay
 * is down: the next poll sees the current state.
 *
 * Requests are conditional (ETag), and GitHub doesn't count a 304 against the
 * rate limit, so polling things that haven't changed is nearly free.
 */
export class GitHubPoller implements ScmProvider {
  readonly id = 'github';
  private readonly apiUrl: string;
  private readonly intervalMs: number;
  private readonly fetch: typeof fetch;
  private readonly openPullRequests = new Map<string, OpenPullRequests>();
  private readonly activity = new Map<string, ActivityWindow>();
  private cache = new Map<string, Cached>();
  private usedThisPoll = new Set<string>();
  private observer: ScmObserver | undefined;

  constructor(private readonly options: GitHubPollerOptions) {
    if (options.token === '') throw new Error('token must not be empty');
    for (const name of options.repositories) {
      if (!REPOSITORY_NAME.test(name)) throw new Error(`repository "${name}" is not an owner/repo name`);
    }
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  start(observer: ScmObserver, signal: AbortSignal): void {
    this.observer = observer;
    runPolling(pollEvery(this.intervalMs, signal, () => this.poll(), this.options.onError ?? (() => {}), this.options.maxConsecutiveFailures), this.options.onFatal);
  }

  /** One pass over every repository. A repository that fails doesn't stop the others; rate limiting does. */
  private async poll(): Promise<void> {
    const observer = this.observer!;
    this.usedThisPoll = new Set();
    const errors: unknown[] = [];
    for (const name of this.options.repositories) {
      try {
        await this.pollRepository(observer, name);
      } catch (error) {
        if (error instanceof RateLimited) throw error;
        errors.push(error);
      }
    }
    // Keeps only what this poll asked for, so the cache doesn't grow with every head ever polled.
    this.cache = new Map([...this.cache].filter(([url]) => this.usedThisPoll.has(url)));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `${errors.length} repositories failed to poll`);
  }

  private async pollRepository(observer: ScmObserver, name: string): Promise<void> {
    let window = this.activity.get(name);
    if (!window) {
      window = new ActivityWindow();
      this.activity.set(name, window);
    }
    const since = window.begin();
    const pulls = (await this.getPages(`${this.apiUrl}/repos/${name}/pulls?state=open&per_page=100`)).filter(isObject);
    const open = new Map<number, Json>();
    for (const pr of pulls) {
      const number = num(pr, 'number');
      if (number !== null && headSha(pr) !== null) open.set(number, pr);
    }

    let tracker = this.openPullRequests.get(name);
    if (!tracker) {
      tracker = new OpenPullRequests();
      this.openPullRequests.set(name, tracker);
    }
    const { changed, gone } = tracker.update(new Map([...open].map(([number, pr]) => [number, headSha(pr)!])));

    for (const { number, before, sha } of changed) {
      const pr = open.get(number)!;
      const repository = baseRepositoryId(pr);
      if (repository === null) continue;
      observer.prHead({ repository, number, before, sha, occurredAt: str(pr, 'updated_at'), url: str(pr, 'html_url') });
    }

    for (const pr of open.values()) {
      await this.pollChecks(observer, name, pr);
      await this.pollReviews(observer, name, pr, since);
      await this.pollMergeability(observer, name, pr);
    }
    await this.pollComments(observer, name, open, since);

    for (const number of gone) {
      const pr = await this.getJson(`${this.apiUrl}/repos/${name}/pulls/${number}`);
      if (!isObject(pr) || str(pr, 'state') === 'open') continue;
      const repository = baseRepositoryId(pr);
      const sha = headSha(pr);
      const closedAt = str(pr, 'closed_at');
      if (repository !== null && sha !== null && closedAt !== null) {
        observer.prClosed({ repository, number, merged: str(pr, 'merged_at') !== null, sha, closedAt, url: str(pr, 'html_url') });
      }
      tracker.forget(number);
    }
    window.succeeded();
  }

  private async pollReviews(observer: ScmObserver, name: string, pr: Json, since: number): Promise<void> {
    const number = num(pr, 'number')!;
    const repository = baseRepositoryId(pr);
    if (repository === null) return;
    for (const review of (await this.getPages(`${this.apiUrl}/repos/${name}/pulls/${number}/reviews?per_page=100`)).filter(isObject)) {
      const id = num(review, 'id');
      const state = REVIEW_STATES[str(review, 'state') ?? ''];
      const submittedAt = str(review, 'submitted_at');
      if (id === null || state === undefined || submittedAt === null || Date.parse(submittedAt) < since) continue;
      observer.review({ repository, number, reviewId: String(id), state, author: login(review), submittedAt, url: str(review, 'html_url') });
    }
  }

  private async pollMergeability(observer: ScmObserver, name: string, pr: Json): Promise<void> {
    const number = num(pr, 'number')!;
    const repository = baseRepositoryId(pr);
    // The PR list leaves `mergeable` out, and GitHub works it out lazily: null means not known yet.
    const detail = await this.getJson(`${this.apiUrl}/repos/${name}/pulls/${number}`);
    if (repository === null || !isObject(detail) || typeof detail.mergeable !== 'boolean') return;
    observer.mergeability({ repository, number, state: detail.mergeable ? 'mergeable' : 'conflicting', url: str(pr, 'html_url') });
  }

  /** Conversation and code comments of the whole repository, made since `since`, on PRs that are open. */
  private async pollComments(observer: ScmObserver, name: string, open: ReadonlyMap<number, Json>, since: number): Promise<void> {
    const after = new Date(since).toISOString();
    const sources = [
      { kind: 'review-comment', url: `${this.apiUrl}/repos/${name}/pulls/comments?since=${after}&per_page=100`, prUrl: 'pull_request_url' },
      { kind: 'issue-comment', url: `${this.apiUrl}/repos/${name}/issues/comments?since=${after}&per_page=100`, prUrl: 'issue_url' },
    ];
    for (const { kind, url, prUrl } of sources) {
      for (const comment of (await this.getPages(url)).filter(isObject)) {
        const id = num(comment, 'id');
        const createdAt = str(comment, 'created_at');
        const number = Number(/\/(\d+)$/.exec(str(comment, prUrl) ?? '')?.[1]);
        const pr = open.get(number);
        // `since` matches edits too; only comments made in the window are new.
        if (id === null || createdAt === null || Date.parse(createdAt) < since || pr === undefined) continue;
        const repository = baseRepositoryId(pr);
        if (repository === null) continue;
        observer.comment({ repository, number, commentId: `${kind}:${id}`, author: login(comment), createdAt, url: str(comment, 'html_url') });
      }
    }
  }

  private async pollChecks(observer: ScmObserver, name: string, pr: Json): Promise<void> {
    const sha = headSha(pr)!;
    const repository = isObject(pr.base) && isObject(pr.base.repo) ? pr.base.repo : null;
    if (repository === null) return;

    const runs: Json[] = [];
    for (const page of await this.getPages(`${this.apiUrl}/repos/${name}/commits/${sha}/check-runs?per_page=100`)) {
      if (isObject(page) && Array.isArray(page.check_runs)) runs.push(...page.check_runs.filter(isObject));
    }
    // Oldest first, so a check's re-run is reported after the run it replaced.
    runs.sort((a, b) => (num(a, 'id') ?? 0) - (num(b, 'id') ?? 0));
    for (const run of runs) {
      const observation = readCiObservation('check_run', { check_run: run, repository });
      if (observation) observer.ci(observation);
    }

    const combined = await this.getJson(`${this.apiUrl}/repos/${name}/commits/${sha}/status?per_page=100`);
    const statuses = isObject(combined) && Array.isArray(combined.statuses) ? combined.statuses.filter(isObject) : [];
    for (const status of statuses) {
      const observation = readCiObservation('status', { ...status, sha, repository });
      if (observation) observer.ci(observation);
    }
  }

  /** Follows `Link: rel="next"`. A page that isn't an array is returned as one item. */
  private async getPages(url: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let next: string | null = url;
    while (next !== null) {
      const { body, link } = await this.get(next);
      if (Array.isArray(body)) items.push(...body);
      else items.push(body);
      next = nextPage(link);
    }
    return items;
  }

  private async getJson(url: string): Promise<unknown> {
    return (await this.get(url)).body;
  }

  private async get(url: string): Promise<{ body: unknown; link: string | null }> {
    this.usedThisPoll.add(url);
    const cached = this.cache.get(url);
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.options.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'event-relay',
    };
    if (cached) headers['if-none-match'] = cached.etag;

    const response = await this.fetch(url, { headers });
    if (response.status === 304 && cached) return { body: cached.body, link: response.headers.get('link') };
    if (response.status === 403 || response.status === 429) {
      const wait = retryAfterMs(response.headers) ?? rateLimitResetMs(response.headers);
      if (wait !== null) throw new RateLimited(wait);
    }
    if (!response.ok) throw new HttpError(response.status, url);

    const body: unknown = await response.json();
    const etag = response.headers.get('etag');
    if (etag !== null) this.cache.set(url, { etag, body });
    return { body, link: response.headers.get('link') };
  }
}

const REVIEW_STATES: Readonly<Record<string, ReviewState>> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented' };

function login(item: Json): string {
  return (isObject(item.user) ? str(item.user, 'login') : null) ?? '';
}

function headSha(pr: Json): string | null {
  return isObject(pr.head) ? str(pr.head, 'sha') : null;
}

function baseRepositoryId(pr: Json): string | null {
  return isObject(pr.base) && isObject(pr.base.repo) ? repositoryId(pr.base.repo) : null;
}

function nextPage(link: string | null): string | null {
  if (link === null) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1]!;
  }
  return null;
}

/** GitHub's primary rate limit: no requests left until `x-ratelimit-reset` (epoch seconds). */
function rateLimitResetMs(headers: Headers, now: number = Date.now()): number | null {
  if (headers.get('x-ratelimit-remaining') !== '0') return null;
  const reset = Number(headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) ? Math.max(0, reset * 1000 - now) : null;
}
