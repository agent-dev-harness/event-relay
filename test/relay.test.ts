import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_SUBJECTS, GAP_KIND, Relay, type GapEvent, type KindSpec, type RelayEvent, type RelayLimits, type SourceContext } from '../src/index';

const INTERVAL = 1_000;

function spec(overrides: Partial<KindSpec> = {}): KindSpec {
  return { kind: 'test.changed', coalesceKey: () => null, overflow: 'drop-oldest', ...overrides };
}

function event(id: string, overrides: Partial<RelayEvent> = {}): RelayEvent {
  return {
    id,
    kind: 'test.changed',
    subject: { type: 'thing', key: 'a' },
    occurredAt: '2026-01-01T00:00:00.000Z',
    observedAt: '2026-01-01T00:00:00.000Z',
    data: { id },
    untrusted: {},
    ...overrides,
  };
}

async function setup(kinds: KindSpec[] = [spec()], limits: Partial<RelayLimits> = {}) {
  const relay = new Relay({ minDeliveryIntervalMs: INTERVAL, ...limits });
  let context: SourceContext | undefined;
  await relay.addSource({ id: 'test', kinds, start: (ctx) => { context = ctx; } });
  const batches: RelayEvent[][] = [];
  const sink = { deliver: vi.fn(async (batch: readonly RelayEvent[]) => { batches.push([...batch]); }) };
  const emit = (e: RelayEvent): void => context!.emit(e);
  return { relay, sink, batches, emit, context: () => context! };
}

const ids = (batch: RelayEvent[] | undefined): string[] => (batch ?? []).map((e) => e.id);
const gaps = (batch: RelayEvent[] | undefined): GapEvent[] => (batch ?? []).filter((e): e is GapEvent => e.kind === GAP_KIND);

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

describe('Relay', () => {
  it('delivers only events matching the filter', async () => {
    const { relay, sink, batches, emit } = await setup([spec(), spec({ kind: 'other.changed' })]);
    relay.subscribe('s', { filter: { kinds: ['test.changed'], subjects: [{ type: 'thing', key: 'a' }] }, sink });

    emit(event('1'));
    emit(event('2', { subject: { type: 'thing', key: 'b' } }));
    emit(event('3', { kind: 'other.changed' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(batches.map(ids)).toEqual([['1']]);
  });

  it('drops an event whose id it has already seen', async () => {
    const { relay, sink, batches, emit } = await setup();
    relay.subscribe('s', { filter: {}, sink });

    emit(event('1'));
    emit(event('1'));
    await vi.advanceTimersByTimeAsync(0);

    expect(batches.map(ids)).toEqual([['1']]);
  });

  it('forgets ids beyond maxDedupeIds', async () => {
    const { relay, sink, batches, emit } = await setup([spec()], { maxDedupeIds: 2 });
    relay.subscribe('s', { filter: {}, sink });

    for (const id of ['1', '2', '3']) emit(event(id));
    await vi.advanceTimersByTimeAsync(0);
    emit(event('1'));
    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(batches.map(ids)).toEqual([['1', '2', '3'], ['1']]);
  });

  it('waits minIntervalMs between deliveries and coalesces what arrives meanwhile', async () => {
    const { relay, sink, batches, emit } = await setup([spec({ coalesceKey: (e) => e.subject.key })]);
    relay.subscribe('s', { filter: {}, sink });

    emit(event('1'));
    await vi.advanceTimersByTimeAsync(0);
    emit(event('2'));
    emit(event('3'));
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(batches.map(ids)).toEqual([['1']]);

    await vi.advanceTimersByTimeAsync(1);
    expect(batches.map(ids)).toEqual([['1'], ['3']]);
  });

  it('refuses a minIntervalMs below the relay minimum', async () => {
    const { relay, sink } = await setup();
    expect(() => relay.subscribe('s', { filter: {}, sink, minIntervalMs: INTERVAL - 1 })).toThrow(RangeError);
  });

  it('refuses subscriptions beyond maxSubscriptions, but still lets an existing one change', async () => {
    const { relay, sink } = await setup([spec()], { maxSubscriptions: 1 });
    relay.subscribe('s', { filter: {}, sink });

    expect(() => relay.subscribe('t', { filter: {}, sink })).toThrow(RangeError);
    expect(() => relay.subscribe('s', { filter: { kinds: [] }, sink })).not.toThrow();
  });

  it('applies a changed filter to later events', async () => {
    const { relay, sink, batches, emit } = await setup();
    relay.subscribe('s', { filter: {}, sink });
    relay.subscribe('s', { filter: { kinds: ['nothing'] }, sink });

    emit(event('1'));
    await vi.advanceTimersByTimeAsync(0);

    expect(batches).toEqual([]);
  });

  it('stops delivering after cancel', async () => {
    const { relay, sink, batches, emit } = await setup();
    relay.subscribe('s', { filter: {}, sink });
    emit(event('1'));

    expect(relay.cancel('s')).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(batches).toEqual([]);
    expect(relay.cancel('s')).toBe(false);
  });

  describe('when it has to drop events, it says so with a gap event', () => {
    it('drop-oldest: drops the oldest queued event', async () => {
      const { relay, sink, batches, emit } = await setup([spec()], { maxQueuedEventsPerSubscriber: 2 });
      relay.subscribe('s', { filter: {}, sink });

      emit(event('1'));
      emit(event('2'));
      emit(event('3'));
      await vi.advanceTimersByTimeAsync(0);

      const [batch] = batches;
      expect(ids(batch).slice(1)).toEqual(['2', '3']);
      expect(gaps(batch)).toEqual([expect.objectContaining({
        subject: { type: 'thing', key: 'a' },
        data: { kinds: ['test.changed'], dropped: 1, reasons: ['queue-full'] },
      })]);
      expect(batch![0]!.kind).toBe(GAP_KIND);
    });

    it('drop-newest: drops the arriving event', async () => {
      const { relay, sink, batches, emit } = await setup([spec({ overflow: 'drop-newest' })], { maxQueuedEventsPerSubscriber: 2 });
      relay.subscribe('s', { filter: {}, sink });

      emit(event('1'));
      emit(event('2'));
      emit(event('3'));
      await vi.advanceTimersByTimeAsync(0);

      expect(ids(batches[0]).slice(1)).toEqual(['1', '2']);
      expect(gaps(batches[0])[0]!.data.dropped).toBe(1);
    });

    it('collapses gaps for more than maxGapSubjectsPerSubscriber subjects into one for every subject', async () => {
      const { relay, sink, batches, emit } = await setup(
        [spec({ overflow: 'drop-newest' })],
        { maxQueuedEventsPerSubscriber: 1, maxGapSubjectsPerSubscriber: 2 },
      );
      relay.subscribe('s', { filter: {}, sink });

      emit(event('0'));
      for (const key of ['a', 'b', 'c', 'd']) emit(event(key, { subject: { type: 'thing', key } }));
      await vi.advanceTimersByTimeAsync(0);

      expect(gaps(batches[0])).toEqual([expect.objectContaining({
        subject: ALL_SUBJECTS,
        data: { kinds: ['test.changed'], dropped: 4, reasons: ['queue-full'] },
      })]);
    });

    it('drops an event larger than maxEventBytes', async () => {
      const { relay, sink, batches, emit } = await setup([spec()], { maxEventBytes: 400 });
      relay.subscribe('s', { filter: {}, sink });

      emit(event('1', { untrusted: { body: 'x'.repeat(400) } }));
      await vi.advanceTimersByTimeAsync(0);

      expect(batches.map(ids)).toEqual([[expect.stringContaining(GAP_KIND)]]);
      expect(gaps(batches[0])[0]!.data.reasons).toEqual(['oversized']);
    });

    it('drops an event queued longer than its kind’s ttlMs', async () => {
      const { relay, sink, batches, emit } = await setup([spec({ ttlMs: INTERVAL / 2 })]);
      relay.subscribe('s', { filter: {}, sink });

      emit(event('1'));
      await vi.advanceTimersByTimeAsync(0);
      emit(event('2'));
      await vi.advanceTimersByTimeAsync(INTERVAL);

      expect(ids(batches[0])).toEqual(['1']);
      expect(gaps(batches[1])[0]!.data.reasons).toEqual(['expired']);
      expect(batches[1]).toHaveLength(1);
    });

    it('counts a delivery that never settles as failed once deliveryTimeoutMs passes', async () => {
      const { relay, batches, emit } = await setup([spec()], { deliveryTimeoutMs: 5_000 });
      const deliver = vi.fn(async (batch: readonly RelayEvent[]) => { batches.push([...batch]); });
      deliver.mockImplementationOnce(() => new Promise(() => {}));
      relay.subscribe('s', { filter: {}, sink: { deliver } });

      emit(event('1'));
      await vi.advanceTimersByTimeAsync(0);
      emit(event('2'));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(deliver).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2);
      expect(gaps(batches[0])[0]!.data).toEqual({ kinds: ['test.changed'], dropped: 1, reasons: ['delivery-failed'] });
      expect(ids(batches[0]).slice(1)).toEqual(['2']);
    });

    it('reports a batch the sink failed to take in the next delivery', async () => {
      const { relay, batches, emit } = await setup();
      const deliver = vi.fn(async (batch: readonly RelayEvent[]) => { batches.push([...batch]); });
      deliver.mockRejectedValueOnce(new Error('down'));
      relay.subscribe('s', { filter: {}, sink: { deliver } });

      emit(event('1'));
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(gaps(batches[0])).toEqual([expect.objectContaining({
        data: { kinds: ['test.changed'], dropped: 1, reasons: ['delivery-failed'] },
      })]);
    });
  });

  describe('limits', () => {
    it.each([
      ['maxQueuedEventsPerSubscriber', 0],
      ['maxSubscriptions', Number.NaN],
      ['maxEventBytes', 1.5],
      ['minDeliveryIntervalMs', Number.POSITIVE_INFINITY],
      ['minDeliveryIntervalMs', -1],
      ['deliveryTimeoutMs', 0],
      ['deliveryTimeoutMs', 2 ** 31],
    ])('refuses %s = %s', (name, value) => {
      expect(() => new Relay({ [name]: value })).toThrow(RangeError);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])('refuses minIntervalMs = %s', async (value) => {
      const { relay, sink } = await setup();
      expect(() => relay.subscribe('s', { filter: {}, sink, minIntervalMs: value })).toThrow(RangeError);
    });
  });

  it('keeps its pace when the wall clock jumps back', async () => {
    const { relay, sink, batches, emit } = await setup();
    relay.subscribe('s', { filter: {}, sink });

    emit(event('1'));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() - 60 * 60 * 1_000);
    emit(event('2'));
    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(batches.map(ids)).toEqual([['1'], ['2']]);
  });

  describe('sources', () => {
    it('leaves the event unseen and unqueued when its coalesceKey throws', async () => {
      const coalesceKey = vi.fn<KindSpec['coalesceKey']>(() => null).mockImplementationOnce(() => { throw new Error('bad key'); });
      const { relay, sink, batches, emit } = await setup([spec({ coalesceKey })]);
      relay.subscribe('s', { filter: {}, sink });
      relay.subscribe('t', { filter: {}, sink });

      expect(() => emit(event('1'))).toThrow('bad key');
      await vi.advanceTimersByTimeAsync(0);
      expect(batches).toEqual([]);

      emit(event('1'));
      await vi.advanceTimersByTimeAsync(0);
      expect(batches.map(ids)).toEqual([['1'], ['1']]);
    });

    it('throws for an event that cannot be serialized, and accepts its id once fixed', async () => {
      const { relay, sink, batches, emit } = await setup();
      relay.subscribe('s', { filter: {}, sink });

      expect(() => emit(event('1', { data: { n: 1n } }))).toThrow(TypeError);
      await vi.advanceTimersByTimeAsync(0);
      expect(batches).toEqual([]);

      emit(event('1'));
      await vi.advanceTimersByTimeAsync(0);
      expect(batches.map(ids)).toEqual([['1']]);
    });

    it('throws when a source emits a kind it did not declare', async () => {
      const { emit } = await setup();
      expect(() => emit(event('1', { kind: 'undeclared' }))).toThrow(/did not declare/);
    });

    it('refuses a second source declaring the same kind with a different spec', async () => {
      const { relay } = await setup();
      await expect(relay.addSource({ id: 'other', kinds: [spec()], start: () => {} })).rejects.toThrow(/different spec/);
    });

    it('delivers one kind from several sources that share its spec', async () => {
      const shared = spec();
      const { relay, sink, batches, emit } = await setup([shared]);
      let other: SourceContext | undefined;
      await relay.addSource({ id: 'other', kinds: [shared], start: (ctx) => { other = ctx; } });
      relay.subscribe('s', { filter: { kinds: ['test.changed'] }, sink });

      emit(event('1'));
      other!.emit(event('2'));
      await vi.advanceTimersByTimeAsync(0);

      expect(batches.map(ids)).toEqual([['1', '2']]);
    });

    it('keeps a shared kind registered for the other source when one fails to start', async () => {
      const shared = spec();
      const { relay, sink, batches, emit } = await setup([shared]);
      await expect(relay.addSource({ id: 'flaky', kinds: [shared], start: () => { throw new Error('no'); } })).rejects.toThrow('no');
      relay.subscribe('s', { filter: {}, sink });

      emit(event('1'));
      await vi.advanceTimersByTimeAsync(0);

      expect(batches.map(ids)).toEqual([['1']]);
    });

    it('unregisters a source whose start fails', async () => {
      const { relay } = await setup([]);
      const failing = { id: 'flaky', kinds: [spec()], start: () => { throw new Error('no'); } };
      await expect(relay.addSource(failing)).rejects.toThrow('no');
      await expect(relay.addSource({ ...failing, start: () => {} })).resolves.toBeUndefined();
    });

    it('aborts the source signal on stop and delivers nothing more', async () => {
      const { relay, sink, batches, emit, context } = await setup();
      relay.subscribe('s', { filter: {}, sink });
      emit(event('1'));

      relay.stop();
      emit(event('2'));
      await vi.advanceTimersByTimeAsync(INTERVAL);

      expect(context().signal.aborted).toBe(true);
      expect(batches).toEqual([]);
    });
  });
});
