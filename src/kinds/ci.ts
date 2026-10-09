import type { KindSpec, RelayEvent, Subject } from '../contract';

export const CI_STATUS_CHANGED = 'ci.status_changed';

/**
 * A check's state, the same for every CI provider. `failure` also covers a
 * check that timed out, couldn't start, needs a person to act, or reported a
 * state the source doesn't recognize; `detail` says which.
 */
export type CiState = 'pending' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral';

/** `data` of a `ci.status_changed` event, whose subject is `commitSubject(repository, sha)`. */
export interface CiStatusChanged {
  /** `<host>/<path>`, e.g. "github.com/owner/repo". */
  repository: string;
  sha: string;
  /**
   * Which of the provider's mechanisms reported the check, e.g. GitHub's
   * "check_run" or "status". With the check's name (in `untrusted.name`) it
   * identifies the check on its commit.
   */
  check: string;
  /** null when the source hasn't seen this check on this commit before, or has forgotten it. */
  from: CiState | null;
  to: CiState;
  /** The provider's own name for the new state, e.g. "timed_out". */
  detail: string;
  url: string | null;
}

export const commitSubject = (repository: string, sha: string): Subject => ({ type: 'commit', key: `${repository}@${sha}` });

export const ciStatusChangedSpec: KindSpec = {
  kind: CI_STATUS_CHANGED,
  // The relay only calls this with events of this kind.
  coalesceKey: (event: RelayEvent) => `${event.subject.key}|${(event.data as CiStatusChanged).check}|${event.untrusted.name}`,
  overflow: 'drop-oldest',
};
