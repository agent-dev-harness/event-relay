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

export const PR_CLOSED = 'pr.closed';

/**
 * `data` of a `pr.closed` event, sent when a pull request is merged or closed
 * without merging. Its subject is `pullRequestSubject(repository, number)`. A PR
 * reopened later sends `pr.head_changed` with `from: null`.
 */
export interface PrClosed {
  /** `<host>/<path>`, e.g. "github.com/owner/repo". */
  repository: string;
  number: number;
  merged: boolean;
  /** The head commit when it closed. */
  head: string;
  url: string | null;
}

export const prClosedSpec: KindSpec = {
  kind: PR_CLOSED,
  coalesceKey: (event) => event.subject.key,
  overflow: 'drop-oldest',
};

export const PR_REVIEW_SUBMITTED = 'pr.review_submitted';

export type ReviewState = 'approved' | 'changes_requested' | 'commented';

/**
 * `data` of a `pr.review_submitted` event: someone reviewed a pull request.
 * Its subject is `pullRequestSubject(repository, number)`. It says that a review
 * arrived, not what it says: fetch the review from `url`. `untrusted.author` is
 * the reviewer.
 */
export interface PrReviewSubmitted {
  /** `<host>/<path>`, e.g. "github.com/owner/repo". */
  repository: string;
  number: number;
  /** Identifies the review within the pull request. */
  reviewId: string;
  state: ReviewState;
  url: string | null;
}

export const prReviewSubmittedSpec: KindSpec = {
  kind: PR_REVIEW_SUBMITTED,
  // A subscriber woken by a review fetches the PR's reviews, so only the latest needs to wait in a queue.
  coalesceKey: (event) => event.subject.key,
  overflow: 'drop-oldest',
};

export const PR_COMMENT_ADDED = 'pr.comment_added';

/**
 * `data` of a `pr.comment_added` event: someone commented on a pull request,
 * in its conversation or on its code. Its subject is
 * `pullRequestSubject(repository, number)`. Fetch the comment from `url`;
 * `untrusted.author` is who wrote it.
 */
export interface PrCommentAdded {
  /** `<host>/<path>`, e.g. "github.com/owner/repo". */
  repository: string;
  number: number;
  /** Identifies the comment within the pull request. */
  commentId: string;
  url: string | null;
}

export const prCommentAddedSpec: KindSpec = {
  kind: PR_COMMENT_ADDED,
  coalesceKey: (event) => event.subject.key,
  overflow: 'drop-oldest',
};

export const PR_MERGEABILITY_CHANGED = 'pr.mergeability_changed';

export type Mergeability = 'mergeable' | 'conflicting';

/**
 * `data` of a `pr.mergeability_changed` event: a pull request started or stopped
 * conflicting with its base. Its subject is `pullRequestSubject(repository, number)`.
 */
export interface PrMergeabilityChanged {
  /** `<host>/<path>`, e.g. "github.com/owner/repo". */
  repository: string;
  number: number;
  /** null when the source hasn't seen this PR's mergeability before, or has forgotten it. */
  from: Mergeability | null;
  to: Mergeability;
  url: string | null;
}

export const prMergeabilityChangedSpec: KindSpec = {
  kind: PR_MERGEABILITY_CHANGED,
  coalesceKey: (event) => event.subject.key,
  overflow: 'drop-oldest',
};
