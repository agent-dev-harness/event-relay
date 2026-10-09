import {
  ALL_SUBJECTS,
  GAP_KIND,
  type GapEvent,
  type GapReason,
  type KindSpec,
  type RelayEvent,
  type Sink,
  type Subject,
  type SubscriptionFilter,
} from '../contract';
import type { RelayLimits } from './limits';

interface Queued {
  event: RelayEvent;
  spec: KindSpec;
  enqueuedAt: number;
}

interface PendingGap {
  subject: Subject;
  kinds: Set<string>;
  dropped: number;
  reasons: Set<GapReason>;
}

const subjectKey = (subject: Subject): string => JSON.stringify([subject.type, subject.key]);
const ALL_SUBJECTS_KEY = subjectKey(ALL_SUBJECTS);

/**
 * One subscriber's bounded queue and delivery loop. At most one delivery is in
 * flight, and deliveries are at least `minIntervalMs` apart; events arriving in
 * between wait, coalesce, and overflow into gaps.
 */
export class Subscription {
  private readonly queue = new Map<string, Queued>();
  private readonly gaps = new Map<string, PendingGap>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delivering = false;
  private lastDeliveryAt = Number.NEGATIVE_INFINITY;
  private gapSeq = 0;
  private cancelled = false;

  constructor(
    readonly id: string,
    private filter: SubscriptionFilter,
    private sink: Sink,
    private minIntervalMs: number,
    private readonly limits: RelayLimits,
  ) {}

  reconfigure(filter: SubscriptionFilter, sink: Sink, minIntervalMs: number): void {
    this.filter = filter;
    this.sink = sink;
    this.minIntervalMs = minIntervalMs;
  }

  matches(event: RelayEvent): boolean {
    const { kinds, subjects } = this.filter;
    if (kinds && !kinds.includes(event.kind)) return false;
    if (subjects && !subjects.some((s) => s.type === event.subject.type && s.key === event.subject.key)) return false;
    return true;
  }

  enqueue(event: RelayEvent, spec: KindSpec): void {
    const coalesceKey = spec.coalesceKey(event);
    const queueKey = coalesceKey === null ? `id:${event.id}` : `key:${spec.kind}:${coalesceKey}`;
    const entry: Queued = { event, spec, enqueuedAt: Date.now() };

    if (this.queue.has(queueKey)) {
      this.queue.delete(queueKey);
      this.queue.set(queueKey, entry);
    } else if (this.queue.size < this.limits.maxQueuedEventsPerSubscriber) {
      this.queue.set(queueKey, entry);
    } else if (spec.overflow === 'drop-oldest') {
      const [oldestKey, oldest] = this.queue.entries().next().value as [string, Queued];
      this.queue.delete(oldestKey);
      this.recordGap(oldest.event.subject, [oldest.event.kind], 1, ['queue-full']);
      this.queue.set(queueKey, entry);
    } else {
      this.recordGap(event.subject, [event.kind], 1, ['queue-full']);
    }
    this.schedule();
  }

  reportDropped(event: RelayEvent, reason: GapReason): void {
    this.recordGap(event.subject, [event.kind], 1, [reason]);
    this.schedule();
  }

  cancel(): void {
    this.cancelled = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.clear();
    this.gaps.clear();
  }

  private recordGap(subject: Subject, kinds: Iterable<string>, dropped: number, reasons: Iterable<GapReason>): void {
    let key = subjectKey(subject);
    if (this.gaps.has(ALL_SUBJECTS_KEY)) {
      key = ALL_SUBJECTS_KEY;
    } else if (!this.gaps.has(key) && this.gaps.size >= this.limits.maxGapSubjectsPerSubscriber) {
      this.collapseGaps();
      key = ALL_SUBJECTS_KEY;
    }
    let gap = this.gaps.get(key);
    if (!gap) {
      gap = { subject: key === ALL_SUBJECTS_KEY ? ALL_SUBJECTS : subject, kinds: new Set(), dropped: 0, reasons: new Set() };
      this.gaps.set(key, gap);
    }
    for (const kind of kinds) gap.kinds.add(kind);
    for (const reason of reasons) gap.reasons.add(reason);
    gap.dropped += dropped;
  }

  private collapseGaps(): void {
    const all: PendingGap = { subject: ALL_SUBJECTS, kinds: new Set(), dropped: 0, reasons: new Set() };
    for (const gap of this.gaps.values()) {
      for (const kind of gap.kinds) all.kinds.add(kind);
      for (const reason of gap.reasons) all.reasons.add(reason);
      all.dropped += gap.dropped;
    }
    this.gaps.clear();
    this.gaps.set(ALL_SUBJECTS_KEY, all);
  }

  private schedule(): void {
    if (this.cancelled || this.delivering || this.timer !== undefined) return;
    if (this.queue.size === 0 && this.gaps.size === 0) return;
    const wait = Math.max(0, this.lastDeliveryAt + this.minIntervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.cancelled) return;
    const now = Date.now();
    const events: RelayEvent[] = [];
    for (const { event, spec, enqueuedAt } of this.queue.values()) {
      if (spec.ttlMs !== undefined && now - enqueuedAt > spec.ttlMs) {
        this.recordGap(event.subject, [event.kind], 1, ['expired']);
      } else {
        events.push(event);
      }
    }
    this.queue.clear();
    const gapEvents = [...this.gaps.values()].map((gap) => this.toGapEvent(gap, now));
    this.gaps.clear();

    const batch: RelayEvent[] = [...gapEvents, ...events];
    if (batch.length === 0) return;

    this.delivering = true;
    this.lastDeliveryAt = now;
    try {
      await this.sink.deliver(batch);
    } catch {
      if (!this.cancelled) {
        for (const gap of gapEvents) this.recordGap(gap.subject, gap.data.kinds, gap.data.dropped, [...gap.data.reasons, 'delivery-failed']);
        for (const event of events) this.recordGap(event.subject, [event.kind], 1, ['delivery-failed']);
      }
    } finally {
      this.delivering = false;
      this.schedule();
    }
  }

  private toGapEvent(gap: PendingGap, now: number): GapEvent {
    const at = new Date(now).toISOString();
    return {
      id: `${GAP_KIND}:${this.id}:${++this.gapSeq}`,
      kind: GAP_KIND,
      subject: gap.subject,
      occurredAt: at,
      observedAt: at,
      data: { kinds: [...gap.kinds], dropped: gap.dropped, reasons: [...gap.reasons] },
      untrusted: {},
    };
  }
}
