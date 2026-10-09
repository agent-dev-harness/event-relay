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
  /** A delivery that hasn't settled by then counts as failed, so a hung sink can't stall its subscription. */
  deliveryTimeoutMs: number;
}

export const DEFAULT_LIMITS: Readonly<RelayLimits> = {
  maxSubscriptions: 1_000,
  maxQueuedEventsPerSubscriber: 1_000,
  maxGapSubjectsPerSubscriber: 100,
  maxEventBytes: 64 * 1024,
  maxDedupeIds: 10_000,
  minDeliveryIntervalMs: 1_000,
  deliveryTimeoutMs: 30_000,
};

/** setTimeout treats a longer delay as 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const COUNT_LIMITS = [
  'maxSubscriptions',
  'maxQueuedEventsPerSubscriber',
  'maxGapSubjectsPerSubscriber',
  'maxEventBytes',
  'maxDedupeIds',
] as const;

export function validateLimits(limits: RelayLimits): void {
  for (const name of COUNT_LIMITS) {
    const value = limits[name];
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  validateInterval('minDeliveryIntervalMs', limits.minDeliveryIntervalMs, 0);
  validateInterval('deliveryTimeoutMs', limits.deliveryTimeoutMs, 1);
}

export function validateInterval(name: string, value: number, min: number): void {
  if (!Number.isFinite(value) || value < min || value > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be between ${min} and ${MAX_TIMER_MS} ms, got ${value}`);
  }
}
