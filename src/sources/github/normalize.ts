/** One CI check's state on one commit, read from a `check_run` or `status` webhook payload. */
export interface CiObservation {
  check: 'check_run' | 'status';
  /** The check run's name or the commit status's context. Written by whoever posts the check. */
  name: string;
  repository: string;
  sha: string;
  /** For a check run its status, or its conclusion once completed; for a commit status its state. */
  state: string;
  /** Unique per payload, so a redelivery maps to the same event. */
  deliveryKey: string;
  occurredAt: string | null;
  url: string | null;
  pullRequests: number[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (obj: Json, key: string): string | null => (typeof obj[key] === 'string' ? obj[key] : null);
const num = (obj: Json, key: string): number | null => (typeof obj[key] === 'number' ? obj[key] : null);

/** Returns null for payloads that aren't a CI state, or lack a field this needs. */
export function readCiObservation(eventName: string, payload: unknown): CiObservation | null {
  if (!isObject(payload) || !isObject(payload.repository)) return null;
  const repository = str(payload.repository, 'full_name');
  if (repository === null) return null;

  if (eventName === 'check_run' && isObject(payload.check_run)) {
    const run = payload.check_run;
    const id = num(run, 'id');
    const name = str(run, 'name');
    const sha = str(run, 'head_sha');
    const status = str(run, 'status');
    if (id === null || name === null || sha === null || status === null) return null;
    const state = status === 'completed' ? (str(run, 'conclusion') ?? status) : status;
    const pullRequests = Array.isArray(run.pull_requests)
      ? run.pull_requests.flatMap((pr) => (isObject(pr) && typeof pr.number === 'number' ? [pr.number] : []))
      : [];
    return {
      check: 'check_run',
      name,
      repository,
      sha,
      state,
      deliveryKey: `check_run:${id}:${state}`,
      occurredAt: str(run, 'completed_at') ?? str(run, 'started_at'),
      url: str(run, 'html_url'),
      pullRequests,
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
      state,
      deliveryKey: `status:${id}`,
      occurredAt: str(payload, 'updated_at') ?? str(payload, 'created_at'),
      url: str(payload, 'target_url'),
      pullRequests: [],
    };
  }

  return null;
}
