import type { ScmObserver, ScmProvider } from '../scm/provider';
import { isObject, num, str, type Json } from '../scm/json';
import { HttpError, OpenPullRequests, pollEvery, RateLimited, retryAfterMs, runPolling, Unexpected } from '../scm/poll';
import { azureCli, personalAccessToken, type Credential, type RunAzureCli } from './auth';
import { buildHeadSha, readBuildObservation, readStatusObservation, sourceHeadSha } from './normalize';

export interface AzureDevOpsPollerOptions {
  /** e.g. "https://dev.azure.com/my-org", or an Azure DevOps Server collection URL. */
  organizationUrl: string;
  /** `project/repository` names. */
  repositories: readonly string[];
  /** A personal access token with Code (read) and Build (read). Give this or `azureCli`. */
  token?: string;
  /** Use the Azure CLI's signed-in account (`az login`) instead of a token. */
  azureCli?: boolean;
  /** How to run `az`; defaults to the `az` on PATH. */
  runAzureCli?: RunAzureCli;
  intervalMs?: number;
  /** Receives each transient failure (network, 5xx, throttling); polling carries on. */
  onError?: (error: unknown) => void;
  /**
   * Receives the failure that stopped polling: a rejected credential, a missing
   * repository, anything unexpected, or `maxConsecutiveFailures` transient ones in
   * a row. Without it the failure is thrown as an uncaught exception.
   */
  onFatal?: (error: unknown) => void;
  maxConsecutiveFailures?: number;
  fetch?: typeof fetch;
}

const API_VERSION = '7.1';
const DEFAULT_INTERVAL_MS = 30_000;
const PAGE_SIZE = 100;
/** Builds read per PR on each poll, newest first. */
const BUILDS_PER_PR = 50;

interface Repository {
  project: string;
  name: string;
  /** `<host>/<path>`, e.g. "dev.azure.com/org/project/_git/repo". */
  id: string;
  /** The repository's REST base URL. */
  api: string;
  web: string;
}

/**
 * Polls each repository's active pull requests, and the pipeline builds and
 * commit statuses for their heads, and turns what changed into observations
 * for an ScmSource.
 *
 * A PR build runs on the PR's merge commit, but CI is reported on the PR head
 * so consumers can match it to `pr.head_changed`; a build whose head can't be
 * worked out is not reported.
 */
export class AzureDevOpsPoller implements ScmProvider {
  readonly id = 'azure-devops';
  private readonly organizationUrl: string;
  private readonly repositories: Repository[];
  private readonly intervalMs: number;
  private readonly fetch: typeof fetch;
  private readonly credential: Credential;
  private readonly openPullRequests = new Map<string, OpenPullRequests>();
  private observer: ScmObserver | undefined;

  constructor(private readonly options: AzureDevOpsPollerOptions) {
    if ((options.token === undefined) === !options.azureCli) throw new Error('give exactly one of token and azureCli');
    if (options.token === '') throw new Error('token must not be empty');
    if (!URL.canParse(options.organizationUrl)) throw new Error(`organizationUrl "${options.organizationUrl}" is not a URL`);
    this.organizationUrl = options.organizationUrl.replace(/\/+$/, '');
    const host = canonicalOrganization(new URL(this.organizationUrl));
    this.repositories = options.repositories.map((name) => {
      const parts = name.split('/');
      if (parts.length !== 2 || parts.some((part) => part === '')) throw new Error(`repository "${name}" is not a project/repository name`);
      const [project, repo] = parts as [string, string];
      const path = `${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;
      return {
        project,
        name: repo,
        id: `${host}/${project}/_git/${repo}`,
        api: `${this.organizationUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`,
        web: `${this.organizationUrl}/${path}`,
      };
    });
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.credential = options.token !== undefined ? personalAccessToken(options.token) : azureCli(options.runAzureCli);
  }

  start(observer: ScmObserver, signal: AbortSignal): void {
    this.observer = observer;
    runPolling(pollEvery(this.intervalMs, signal, () => this.poll(), this.options.onError ?? (() => {}), this.options.maxConsecutiveFailures), this.options.onFatal);
  }

  /** One pass over every repository. A repository that fails doesn't stop the others; rate limiting does. */
  private async poll(): Promise<void> {
    const observer = this.observer!;
    const errors: unknown[] = [];
    for (const repository of this.repositories) {
      try {
        await this.pollRepository(observer, repository);
      } catch (error) {
        if (error instanceof RateLimited) throw error;
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `${errors.length} repositories failed to poll`);
  }

  private async pollRepository(observer: ScmObserver, repository: Repository): Promise<void> {
    const open = new Map<number, Json>();
    for (let skip = 0; ; skip += PAGE_SIZE) {
      const page = await this.getList(`${repository.api}/pullrequests?searchCriteria.status=active&$top=${PAGE_SIZE}&$skip=${skip}`);
      for (const pr of page) {
        const number = num(pr, 'pullRequestId');
        if (number !== null && sourceHeadSha(pr) !== null) open.set(number, pr);
      }
      if (page.length < PAGE_SIZE) break;
    }

    let tracker = this.openPullRequests.get(repository.id);
    if (!tracker) {
      tracker = new OpenPullRequests();
      this.openPullRequests.set(repository.id, tracker);
    }
    const { changed, gone } = tracker.update(new Map([...open].map(([number, pr]) => [number, sourceHeadSha(pr)!])));

    for (const { number, before, sha } of changed) {
      observer.prHead({ repository: repository.id, number, before, sha, occurredAt: null, url: `${repository.web}/pullrequest/${number}` });
    }

    for (const [number, pr] of open) await this.pollChecks(observer, repository, number, pr);

    for (const number of gone) {
      const pr = await this.getJson(`${repository.api}/pullrequests/${number}`);
      if (!isObject(pr)) continue;
      const status = str(pr, 'status');
      if (status === 'active') continue;
      const sha = sourceHeadSha(pr);
      const closedAt = str(pr, 'closedDate');
      if ((status === 'completed' || status === 'abandoned') && sha !== null && closedAt !== null) {
        observer.prClosed({ repository: repository.id, number, merged: status === 'completed', sha, closedAt, url: `${repository.web}/pullrequest/${number}` });
      }
      tracker.forget(number);
    }
  }

  private async pollChecks(observer: ScmObserver, repository: Repository, number: number, pr: Json): Promise<void> {
    const head = sourceHeadSha(pr)!;
    const builds = await this.getList(
      `${this.organizationUrl}/${encodeURIComponent(repository.project)}/_apis/build/builds`
        + `?branchName=${encodeURIComponent(`refs/pull/${number}/merge`)}&queryOrder=queueTimeDescending&$top=${BUILDS_PER_PR}`,
    );
    // Oldest first, so a re-run is reported after the build it replaced.
    builds.sort((a, b) => (num(a, 'id') ?? 0) - (num(b, 'id') ?? 0));
    for (const build of builds) {
      const sha = buildHeadSha(build, pr);
      const observation = sha === null ? null : readBuildObservation(repository.id, sha, build);
      if (observation) observer.ci(observation);
    }

    const statuses = await this.getList(`${repository.api}/commits/${head}/statuses?latestOnly=true`);
    for (const status of statuses) {
      const observation = readStatusObservation(repository.id, head, status);
      if (observation) observer.ci(observation);
    }
  }

  /** A list response's `value` array. */
  private async getList(url: string): Promise<Json[]> {
    const body = await this.getJson(url);
    return isObject(body) && Array.isArray(body.value) ? body.value.filter(isObject) : [];
  }

  private async getJson(url: string, retried = false): Promise<unknown> {
    const withVersion = `${url}${url.includes('?') ? '&' : '?'}api-version=${API_VERSION}`;
    const authorization = await this.credential.header();
    const response = await this.fetch(withVersion, { headers: { accept: 'application/json', authorization } });
    if (response.status === 429 || response.status === 503) {
      const wait = retryAfterMs(response.headers);
      if (wait !== null) throw new RateLimited(wait);
    }
    // Azure DevOps can answer a bad or expired credential with a sign-in page (203) instead of a 401.
    const signIn = response.ok && !(response.headers.get('content-type') ?? '').includes('application/json');
    if (response.status === 401 || signIn) {
      if (!retried && this.credential.rejected()) return this.getJson(url, true);
      throw new Unexpected(`Azure DevOps rejected the credential (HTTP ${response.status}) for ${withVersion}`);
    }
    if (!response.ok) throw new HttpError(response.status, withVersion);
    return response.json();
  }
}

/** `<org>.visualstudio.com` is the older URL of `dev.azure.com/<org>`; both name one organization. */
function canonicalOrganization(url: URL): string {
  const legacy = /^([^.]+)\.visualstudio\.com$/i.exec(url.host);
  const path = url.pathname.replace(/\/+$/, '');
  return legacy ? `dev.azure.com/${legacy[1]!.toLowerCase()}${path}` : `${url.host}${path}`;
}
