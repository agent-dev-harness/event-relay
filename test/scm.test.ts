import { describe, expect, it } from 'vitest';
import type { RelayEvent } from '../src/contract';
import { CI_STATUS_CHANGED, PR_HEAD_CHANGED, type CiStatusChanged, type PrHeadChanged } from '../src/kinds/index';
import { ScmSource, type CiObservation, type PrHeadObservation, type ScmObserver, type ScmProvider } from '../src/sources/scm/index';

class FakeProvider implements ScmProvider {
  readonly id = 'fake';
  observer: ScmObserver | undefined;
  signal: AbortSignal | undefined;

  start(observer: ScmObserver, signal: AbortSignal): void {
    this.observer = observer;
    this.signal = signal;
  }
}

function ci(overrides: Partial<CiObservation> = {}): CiObservation {
  return {
    repository: 'host.example/o/r',
    sha: 'abc',
    check: 'job',
    name: 'build',
    state: 'pending',
    detail: 'queued',
    deliveryKey: 'job:1:queued',
    order: [1, 0],
    occurredAt: '2026-01-01T00:00:00Z',
    url: null,
    ...overrides,
  };
}

function prHead(overrides: Partial<PrHeadObservation> = {}): PrHeadObservation {
  return { repository: 'host.example/o/r', number: 7, before: null, sha: 'abc', occurredAt: null, url: null, ...overrides };
}

function started(options: { maxTrackedChecks?: number } = {}, emit?: (event: RelayEvent) => void) {
  const provider = new FakeProvider();
  const emitted: RelayEvent[] = [];
  const controller = new AbortController();
  void new ScmSource(provider, options).start({ emit: emit ?? ((e) => emitted.push(e)), signal: controller.signal });
  return { observer: provider.observer!, provider, emitted, controller };
}

const transitions = (emitted: RelayEvent[]) => emitted.map((e) => [(e.data as CiStatusChanged).from, (e.data as CiStatusChanged).to]);

describe('ScmSource', () => {
  it('starts its provider with the relay signal and takes the provider id', () => {
    const provider = new FakeProvider();
    const controller = new AbortController();
    const source = new ScmSource(provider);

    void source.start({ emit: () => {}, signal: controller.signal });

    expect(source.id).toBe('fake');
    expect(provider.signal).toBe(controller.signal);
  });

  describe('ci.status_changed', () => {
    it('reports each change of a check, with the name kept out of data', () => {
      const { observer, emitted } = started();

      expect(observer.ci(ci())).toBe('accepted');
      observer.ci(ci({ state: 'failure', detail: 'timed_out', deliveryKey: 'job:1:timed_out', order: [1, 2] }));

      expect(transitions(emitted)).toEqual([[null, 'pending'], ['pending', 'failure']]);
      expect(emitted[1]).toEqual({
        id: 'fake:job:1:timed_out',
        kind: CI_STATUS_CHANGED,
        subject: { type: 'commit', key: 'host.example/o/r@abc' },
        occurredAt: '2026-01-01T00:00:00Z',
        observedAt: expect.any(String),
        data: { repository: 'host.example/o/r', sha: 'abc', check: 'job', from: 'pending', to: 'failure', detail: 'timed_out', url: null },
        untrusted: { name: 'build' },
      });
    });

    it('reports nothing when the state has not changed', () => {
      const { observer, emitted } = started();

      observer.ci(ci());
      expect(observer.ci(ci({ detail: 'waiting', order: [1, 1] }))).toBe('no change');

      expect(emitted).toHaveLength(1);
    });

    it('drops an update older than the last one for that check', () => {
      const { observer, emitted } = started();

      observer.ci(ci({ order: [2, 0] }));
      expect(observer.ci(ci({ state: 'success', order: [1, 5] }))).toBe('stale');
      expect(observer.ci(ci({ state: 'running', order: [2, 1] }))).toBe('accepted');

      expect(transitions(emitted)).toEqual([[null, 'pending'], ['pending', 'running']]);
    });

    it('tracks checks with the same name from different mechanisms apart', () => {
      const { observer, emitted } = started();

      observer.ci(ci({ check: 'job' }));
      observer.ci(ci({ check: 'status', deliveryKey: 'status:9' }));

      expect(transitions(emitted)).toEqual([[null, 'pending'], [null, 'pending']]);
    });

    it('forgets the oldest check beyond maxTrackedChecks', () => {
      const { observer, emitted } = started({ maxTrackedChecks: 1 });

      observer.ci(ci({ name: 'a', deliveryKey: 'a' }));
      observer.ci(ci({ name: 'b', deliveryKey: 'b' }));
      observer.ci(ci({ name: 'a', deliveryKey: 'a2', order: [2, 0] }));

      expect(transitions(emitted)).toEqual([[null, 'pending'], [null, 'pending'], [null, 'pending']]);
    });

    it('still reports a change whose emit threw when it comes again', () => {
      const emitted: RelayEvent[] = [];
      let fail = true;
      const { observer } = started({}, (e) => {
        if (fail) throw new Error('relay refused');
        emitted.push(e);
      });

      expect(() => observer.ci(ci())).toThrow('relay refused');
      fail = false;
      observer.ci(ci());

      expect(emitted).toHaveLength(1);
    });
  });

  describe('pr.head_changed', () => {
    it('reports a moved head with both commits in its id', () => {
      const { observer, emitted } = started();

      observer.prHead(prHead({ before: 'abc', sha: 'def' }));

      expect(emitted[0]).toMatchObject({
        id: 'fake:pull_request:host.example/o/r#7:abc..def',
        kind: PR_HEAD_CHANGED,
        subject: { type: 'pull_request', key: 'host.example/o/r#7' },
      });
      expect(emitted[0]!.data as PrHeadChanged).toEqual({ repository: 'host.example/o/r', number: 7, from: 'abc', to: 'def', url: null });
    });

    it('reports nothing when the head did not move', () => {
      const { observer, emitted } = started();

      expect(observer.prHead(prHead({ before: 'abc', sha: 'abc' }))).toBe('no change');

      expect(emitted).toEqual([]);
    });
  });
});
