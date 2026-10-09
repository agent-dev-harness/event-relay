import type { CiState } from '../../kinds';

/** One CI check's state on one commit, read from a `check_run` or `status` webhook payload. */
export interface CiObservation {
  check: 'check_run' | 'status';
  /** The check run's name or the commit status's context. Written by whoever posts the check. */
  name: string;
  /** `<host>/<owner>/<repo>`. */
  repository: string;
  sha: string;
  state: CiState;
  /** For a check run its status, or its conclusion once completed; for a commit status its state. */
  detail: string;
  /** Unique per payload, so a redelivery maps to the same event. */
  deliveryKey: string;
  /**
   * Compared element by element, a later update of the same check is greater.
   * GitHub's ids grow with each new check run or status, and one run goes
   * queued → in_progress → completed.
   */
  order: readonly [id: number, step: number];
  occurredAt: string | null;
  url: string | null;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (obj: Json, key: string): string | null => (typeof obj[key] === 'string' ? obj[key] : null);
const num = (obj: Json, key: string): number | null => (typeof obj[key] === 'number' ? obj[key] : null);

const CHECK_RUN_STEPS: Readonly<Record<string, number>> = { in_progress: 1, completed: 2 };

const CI_STATES: Readonly<Record<string, CiState>> = {
  queued: 'pending',
  requested: 'pending',
  waiting: 'pending',
  pending: 'pending',
  in_progress: 'running',
  success: 'success',
  failure: 'failure',
  error: 'failure',
  timed_out: 'failure',
  startup_failure: 'failure',
  action_required: 'failure',
  cancelled: 'cancelled',
  stale: 'cancelled',
  skipped: 'skipped',
  neutral: 'neutral',
};

// Unknown states count as failure so a new GitHub value is looked at, not taken as passing.
const toCiState = (detail: string): CiState => CI_STATES[detail] ?? 'failure';

/** `<host>/<owner>/<repo>`, so the same path on two hosts names two repositories. */
function repositoryId(repository: Json): string | null {
  const fullName = str(repository, 'full_name');
  const htmlUrl = str(repository, 'html_url');
  if (fullName === null || htmlUrl === null || !URL.canParse(htmlUrl)) return null;
  return `${new URL(htmlUrl).host}/${fullName}`;
}

/** Returns null for payloads that aren't a CI state, or lack a field this needs. */
export function readCiObservation(eventName: string, payload: unknown): CiObservation | null {
  if (!isObject(payload) || !isObject(payload.repository)) return null;
  const repository = repositoryId(payload.repository);
  if (repository === null) return null;

  if (eventName === 'check_run' && isObject(payload.check_run)) {
    const run = payload.check_run;
    const id = num(run, 'id');
    const name = str(run, 'name');
    const sha = str(run, 'head_sha');
    const status = str(run, 'status');
    if (id === null || name === null || sha === null || status === null) return null;
    const detail = status === 'completed' ? (str(run, 'conclusion') ?? status) : status;
    return {
      check: 'check_run',
      name,
      repository,
      sha,
      state: toCiState(detail),
      detail,
      deliveryKey: `check_run:${id}:${detail}`,
      order: [id, CHECK_RUN_STEPS[status] ?? 0],
      occurredAt: str(run, 'completed_at') ?? str(run, 'started_at'),
      url: str(run, 'html_url'),
    };
  }

  if (eventName === 'status') {
    const id = num(payload, 'id');
    const context = str(payload, 'context');
    const sha = str(payload, 'sha');
    const state = str(payload, 'state');
    if (id === null || context === null || sha === null || state === null) return null;
    return {
      check: 'status',
      name: context,
      repository,
      sha,
      state: toCiState(state),
      detail: state,
      deliveryKey: `status:${id}`,
      order: [id, 0],
      occurredAt: str(payload, 'updated_at') ?? str(payload, 'created_at'),
      url: str(payload, 'target_url'),
    };
  }

  return null;
}

/** A PR's head commit as of a `pull_request` webhook that can change it. */
export interface PrHeadObservation {
  /** `<host>/<owner>/<repo>`. */
  repository: string;
  number: number;
  /** The head before this payload: `before` on a push to the PR, else null. */
  before: string | null;
  sha: string;
  occurredAt: string | null;
  url: string | null;
}

const HEAD_ACTIONS: ReadonlySet<string> = new Set(['opened', 'reopened', 'synchronize']);

/** Returns null for payloads that don't set a PR's head, or lack a field this needs. */
export function readPrHeadObservation(eventName: string, payload: unknown): PrHeadObservation | null {
  if (eventName !== 'pull_request' || !isObject(payload) || !isObject(payload.repository)) return null;
  const action = str(payload, 'action');
  if (action === null || !HEAD_ACTIONS.has(action) || !isObject(payload.pull_request)) return null;
  const pr = payload.pull_request;
  const repository = repositoryId(payload.repository);
  const number = num(pr, 'number');
  const sha = isObject(pr.head) ? str(pr.head, 'sha') : null;
  if (repository === null || number === null || sha === null) return null;
  return {
    repository,
    number,
    before: action === 'synchronize' ? str(payload, 'before') : null,
    sha,
    occurredAt: str(pr, 'updated_at'),
    url: str(pr, 'html_url'),
  };
}
