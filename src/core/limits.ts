/** Every buffer the relay keeps is capped by one of these. */
export interface RelayLimits {
  maxSubscriptions: number;
  /** Events waiting for one subscriber, after coalescing. */
  maxQueuedEventsPerSubscriber: number;
  /** Subjects one subscriber can have pending gaps for; beyond it they collapse into one gap for ALL_SUBJECTS. */
  maxGapSubjectsPerSubscriber: number;
  /** Size of one event as JSON. A bigger event is dropped and reported as a gap. */
  maxEventBytes: number;
  /** Event ids remembered for dedupe. An id older than this many events can be delivered again. */
  maxDedupeIds: number;
  /** Shortest interval between deliveries to one subscriber, and the default when it sets none. */
  minDeliveryIntervalMs: number;
}

export const DEFAULT_LIMITS: Readonly<RelayLimits> = {
  maxSubscriptions: 1_000,
  maxQueuedEventsPerSubscriber: 1_000,
  maxGapSubjectsPerSubscriber: 100,
  maxEventBytes: 64 * 1024,
  maxDedupeIds: 10_000,
  minDeliveryIntervalMs: 1_000,
};
