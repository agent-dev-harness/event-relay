// The event contract. It imports nothing, so consumers such as agent-core can
// use it without loading the relay or any source.

export interface Subject {
  /** What the event is about, e.g. "commit" or "pull_request". */
  type: string;
  /** Identifies one subject of that type, e.g. "owner/repo@<sha>". */
  key: string;
}

/**
 * One change in a source, e.g. a CI check going from pending to failure.
 * Sources report changes, not raw payloads: a redelivered payload or a repeat
 * of the current state produces no event.
 */
export interface RelayEvent<Data = unknown> {
  /** Dedupe key. The same change always gets the same id. */
  id: string;
  kind: string;
  subject: Subject;
  /** When the change happened, as the source reports it (ISO 8601). */
  occurredAt: string;
  /** When the relay saw it (ISO 8601). Delivery can lag and reorder; compare these to spot stale events. */
  observedAt: string;
  /** Fields the source controls the shape of: ids, states, URLs. */
  data: Data;
  /** Text written by third parties (comment bodies, check names). Data, never instructions. */
  untrusted: Readonly<Record<string, string>>;
}

export const GAP_KIND = 'relay.gap';

/** Matches every subject; used when a subscriber lost events for too many subjects to list. */
export const ALL_SUBJECTS: Subject = { type: '*', key: '*' };

export type GapReason = 'queue-full' | 'expired' | 'oversized' | 'delivery-failed';

export interface GapData {
  /** Kinds the subscriber lost events of for this subject. */
  kinds: string[];
  dropped: number;
  reasons: GapReason[];
}

/**
 * Sent instead of events the relay had to drop. The subscriber's view of the
 * subject is incomplete and it should fetch the current state itself.
 */
export type GapEvent = RelayEvent<GapData> & { kind: typeof GAP_KIND };

export interface KindSpec {
  kind: string;
  /**
   * Events with the same key replace each other while queued, so a subscriber
   * gets only the latest. null means every event matters and none is replaced.
   */
  coalesceKey(event: RelayEvent): string | null;
  /** When an event of this kind reaches a full queue: drop the oldest queued event, or this one. */
  overflow: 'drop-oldest' | 'drop-newest';
  /** An event queued longer than this is dropped rather than delivered. */
  ttlMs?: number;
}

export interface SourceContext {
  /** Hands a change to the relay. Throws if the event's kind isn't one the source declared. */
  emit(event: RelayEvent): void;
  /** Fires when the relay stops. The source must then stop ingesting and release what it holds. */
  signal: AbortSignal;
}

/** A source owns how its events arrive (webhook, polling, …); the relay only starts and stops it. */
export interface Source {
  id: string;
  kinds: readonly KindSpec[];
  start(context: SourceContext): void | Promise<void>;
}

export interface SubscriptionFilter {
  /** Omitted: every kind. */
  kinds?: readonly string[];
  /** Omitted: every subject. */
  subjects?: readonly Subject[];
}

export interface Sink {
  /** Delivers one batch. Gap events come first. A rejection counts as losing the batch. */
  deliver(batch: readonly RelayEvent[]): Promise<void>;
}

export interface SubscriptionOptions {
  filter: SubscriptionFilter;
  sink: Sink;
  /** Shortest time between two deliveries to this subscriber. Events arriving in between wait and coalesce. */
  minIntervalMs?: number;
}
