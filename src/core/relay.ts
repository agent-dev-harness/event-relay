import type { KindSpec, RelayEvent, Source, SubscriptionOptions } from '../contract';
import { BoundedLru } from './boundedLru';
import { DEFAULT_LIMITS, type RelayLimits } from './limits';
import { Subscription } from './subscription';

interface RegisteredKind {
  spec: KindSpec;
  sourceId: string;
}

export class Relay {
  private readonly limits: RelayLimits;
  private readonly sources = new Set<string>();
  private readonly kinds = new Map<string, RegisteredKind>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly seen: BoundedLru<string, true>;
  private readonly stopController = new AbortController();

  constructor(limits: Partial<RelayLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.seen = new BoundedLru(this.limits.maxDedupeIds);
  }

  /** Registers a source and its kinds, then starts it. */
  async addSource(source: Source): Promise<void> {
    if (this.stopController.signal.aborted) throw new Error('relay is stopped');
    if (this.sources.has(source.id)) throw new Error(`source "${source.id}" is already registered`);
    for (const spec of source.kinds) {
      const owner = this.kinds.get(spec.kind);
      if (owner) throw new Error(`kind "${spec.kind}" is already registered by source "${owner.sourceId}"`);
    }

    this.sources.add(source.id);
    for (const spec of source.kinds) this.kinds.set(spec.kind, { spec, sourceId: source.id });
    try {
      await source.start({ emit: (event) => this.emit(source.id, event), signal: this.stopController.signal });
    } catch (error) {
      this.sources.delete(source.id);
      for (const spec of source.kinds) this.kinds.delete(spec.kind);
      throw error;
    }
  }

  /**
   * Creates a subscription, or changes the one with this id. A change applies to
   * events emitted after it; events already queued are still delivered.
   */
  subscribe(id: string, options: SubscriptionOptions): void {
    if (this.stopController.signal.aborted) throw new Error('relay is stopped');
    const minIntervalMs = options.minIntervalMs ?? this.limits.minDeliveryIntervalMs;
    if (minIntervalMs < this.limits.minDeliveryIntervalMs) {
      throw new RangeError(`minIntervalMs ${minIntervalMs} is below the relay's minimum of ${this.limits.minDeliveryIntervalMs}`);
    }

    const existing = this.subscriptions.get(id);
    if (existing) {
      existing.reconfigure(options.filter, options.sink, minIntervalMs);
      return;
    }
    if (this.subscriptions.size >= this.limits.maxSubscriptions) {
      throw new RangeError(`the relay already has its maximum of ${this.limits.maxSubscriptions} subscriptions`);
    }
    this.subscriptions.set(id, new Subscription(id, options.filter, options.sink, minIntervalMs, this.limits));
  }

  /** Returns false if there was no subscription with this id. */
  cancel(id: string): boolean {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return false;
    subscription.cancel();
    this.subscriptions.delete(id);
    return true;
  }

  /** Stops every source and drops every subscription without delivering what's queued. */
  stop(): void {
    this.stopController.abort();
    for (const subscription of this.subscriptions.values()) subscription.cancel();
    this.subscriptions.clear();
  }

  private emit(sourceId: string, event: RelayEvent): void {
    const registered = this.kinds.get(event.kind);
    if (!registered || registered.sourceId !== sourceId) {
      throw new Error(`source "${sourceId}" emitted kind "${event.kind}", which it did not declare`);
    }
    if (this.stopController.signal.aborted || this.seen.has(event.id)) return;
    this.seen.set(event.id, true);

    const matching = [...this.subscriptions.values()].filter((s) => s.matches(event));
    if (matching.length === 0) return;

    if (Buffer.byteLength(JSON.stringify(event)) > this.limits.maxEventBytes) {
      for (const subscription of matching) subscription.reportDropped(event, 'oversized');
      return;
    }
    for (const subscription of matching) subscription.enqueue(event, registered.spec);
  }
}
