// Helpers shared by providers that poll a code host instead of receiving its webhooks.

/** The host asked us to wait before calling it again. */
export class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`rate limited for ${retryAfterMs} ms`);
  }
}

/** An unexpected HTTP status from the host. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} from ${url}`);
  }
}

/** Reads `Retry-After` (seconds or an HTTP date); null when absent or unreadable. */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | null {
  const value = headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export interface HeadChange {
  number: number;
  /** null when the PR is new since the last poll: it was opened or reopened. */
  before: string | null;
  sha: string;
}

/**
 * One repository's open pull requests as of the last poll. The first poll only
 * records them: a PR already open when polling starts was not just opened, so
 * reporting it with `before: null` would tell consumers it was.
 */
export class OpenPullRequests {
  private readonly heads = new Map<number, string>();
  private seeded = false;

  /**
   * Takes this poll's open PRs (number → head sha). Returns the heads that moved
   * or appeared, and the PRs no longer open. A PR stays remembered until `forget`
   * is called, so a close that couldn't be read is retried on the next poll.
   */
  update(open: ReadonlyMap<number, string>): { changed: HeadChange[]; gone: number[] } {
    const changed: HeadChange[] = [];
    for (const [number, sha] of open) {
      const before = this.heads.get(number) ?? null;
      if (before !== sha && this.seeded) changed.push({ number, before, sha });
      this.heads.set(number, sha);
    }
    this.seeded = true;
    const gone = [...this.heads.keys()].filter((number) => !open.has(number));
    return { changed, gone };
  }

  forget(number: number): void {
    this.heads.delete(number);
  }
}

/** Resolves after `ms`, or as soon as `signal` fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/**
 * Calls `poll` now and then every `intervalMs` until `signal` fires. A failed
 * poll goes to `onError` and the loop carries on; after `RateLimited` it waits
 * at least as long as the host asked.
 */
export async function pollEvery(intervalMs: number, signal: AbortSignal, poll: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
  while (!signal.aborted) {
    let wait = intervalMs;
    try {
      await poll();
    } catch (error) {
      if (error instanceof RateLimited) wait = Math.max(wait, error.retryAfterMs);
      onError(error);
    }
    await sleep(wait, signal);
  }
}
