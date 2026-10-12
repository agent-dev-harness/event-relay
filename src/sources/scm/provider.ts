import type { CiState, Mergeability, ReviewState } from '../../kinds';

/** One CI check's state on one commit, as a provider reports it. */
export interface CiObservation {
  /** `<host>/<path>`, e.g. "github.com/owner/repo". */
  repository: string;
  /**
   * The commit the check ran for. For a PR, the PR's head commit, not a merge
   * commit CI built from it, so consumers can match it to `pr.head_changed`.
   */
  sha: string;
  /** Which of the provider's mechanisms reported the check, e.g. GitHub's "check_run". */
  check: string;
  /** The check's name. Written by whoever posts the check, so it is never trusted. */
  name: string;
  state: CiState;
  /** The provider's own name for the state, e.g. "timed_out". */
  detail: string;
  /** Unique per update, so a redelivered update maps to the same event. */
  deliveryKey: string;
  /**
   * Compared element by element, a later update of the same check is greater.
   * The provider decides what the numbers are.
   */
  order: readonly [number, number];
  occurredAt: string | null;
  url: string | null;
}

/** A pull request's head commit, as a provider reports it when the head may have moved. */
export interface PrHeadObservation {
  /** `<host>/<path>`. */
  repository: string;
  number: number;
  /**
   * The head before this update; null only when the PR was opened or reopened,
   * since consumers read a null `from` as that.
   */
  before: string | null;
  sha: string;
  occurredAt: string | null;
  url: string | null;
}

/** A pull request that was merged or closed, as a provider reports it. */
export interface PrClosedObservation {
  /** `<host>/<path>`. */
  repository: string;
  number: number;
  merged: boolean;
  /** The head commit when it closed. */
  sha: string;
  /** When it closed; tells a second close after a reopen apart from a redelivered one. */
  closedAt: string;
  url: string | null;
}

/** A review submitted on a pull request, reported once. */
export interface ReviewObservation {
  /** `<host>/<path>`. */
  repository: string;
  number: number;
  /** Unique within the pull request, and the same each time this review is reported. */
  reviewId: string;
  state: ReviewState;
  /** Written by whoever reviewed, so it is never trusted. */
  author: string;
  submittedAt: string | null;
  url: string | null;
}

/** A comment added to a pull request, in its conversation or on its code, reported once. */
export interface CommentObservation {
  /** `<host>/<path>`. */
  repository: string;
  number: number;
  /** Unique within the pull request, and the same each time this comment is reported. */
  commentId: string;
  /** Written by whoever commented, so it is never trusted. */
  author: string;
  createdAt: string | null;
  url: string | null;
}

/** Whether a pull request merges cleanly, as of this poll. Not reported while the host is still working it out. */
export interface MergeabilityObservation {
  /** `<host>/<path>`. */
  repository: string;
  number: number;
  state: Mergeability;
  url: string | null;
}

/** What ScmSource did with an observation. */
export type ObservationOutcome = 'accepted' | 'no change' | 'stale';

export interface ScmObserver {
  ci(observation: CiObservation): ObservationOutcome;
  prHead(observation: PrHeadObservation): ObservationOutcome;
  prClosed(observation: PrClosedObservation): ObservationOutcome;
  review(observation: ReviewObservation): ObservationOutcome;
  comment(observation: CommentObservation): ObservationOutcome;
  mergeability(observation: MergeabilityObservation): ObservationOutcome;
}

/**
 * Turns one code host's updates (webhooks, polling, …) into observations. It
 * knows the host's payloads and nothing about events or the relay.
 */
export interface ScmProvider {
  /** Prefixes event ids, and names the source in the relay. */
  id: string;
  /** Starts handing observations to `observer`; stops when `signal` fires. */
  start(observer: ScmObserver, signal: AbortSignal): void | Promise<void>;
}
