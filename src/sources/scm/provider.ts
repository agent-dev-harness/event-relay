import type { CiState } from '../../kinds';

/** One CI check's state on one commit, as a provider reports it. */
export interface CiObservation {
  /** `<host>/<path>`, e.g. "github.com/owner/repo". */
  repository: string;
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
  /** The head before this update, when the provider knows it. */
  before: string | null;
  sha: string;
  occurredAt: string | null;
  url: string | null;
}

/** What ScmSource did with an observation. */
export type ObservationOutcome = 'accepted' | 'no change' | 'stale';

export interface ScmObserver {
  ci(observation: CiObservation): ObservationOutcome;
  prHead(observation: PrHeadObservation): ObservationOutcome;
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
