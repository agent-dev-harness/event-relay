import type { KindSpec, Subject } from '../contract';

export const PR_HEAD_CHANGED = 'pr.head_changed';

/**
 * `data` of a `pr.head_changed` event, sent when a pull request is opened or
 * reopened or gets new commits. Its subject is `pullRequestSubject(repository, number)`.
 * The new head's CI arrives as `ci.status_changed` on `commitSubject(repository, to)`.
 */
export interface PrHeadChanged {
  /** `<host>/<path>`, e.g. "github.com/owner/repo". */
  repository: string;
  number: number;
  /** The previous head on a push to the PR; null when it was opened or reopened. */
  from: string | null;
  to: string;
  url: string | null;
}

export const pullRequestSubject = (repository: string, number: number): Subject => ({ type: 'pull_request', key: `${repository}#${number}` });

export const prHeadChangedSpec: KindSpec = {
  kind: PR_HEAD_CHANGED,
  coalesceKey: (event) => event.subject.key,
  overflow: 'drop-oldest',
};
