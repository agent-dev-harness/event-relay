import type { RelayEvent, Source, SourceContext } from '../../contract';
import { BoundedLru } from '../../core/boundedLru';
import {
  CI_STATUS_CHANGED,
  ciStatusChangedSpec,
  commitSubject,
  PR_HEAD_CHANGED,
  prHeadChangedSpec,
  pullRequestSubject,
  type CiState,
  type CiStatusChanged,
  type PrHeadChanged,
} from '../../kinds';
import type { CiObservation, ObservationOutcome, PrHeadObservation, ScmProvider } from './provider';

export type { CiObservation, ObservationOutcome, PrHeadObservation, ScmObserver, ScmProvider } from './provider';

export interface ScmSourceOptions {
  /** Checks whose last state is remembered to suppress repeats. */
  maxTrackedChecks?: number;
}

const DEFAULT_MAX_TRACKED_CHECKS = 10_000;

const isBefore = (a: CiObservation['order'], b: CiObservation['order']): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/**
 * Emits `ci.status_changed` and `pr.head_changed` from a code host's
 * observations, whichever host the provider talks to.
 *
 * A check is reported only when its CiState changes, and an update older than
 * the last one reported for that check is dropped, so a late `in_progress`
 * never follows its `completed`.
 */
export class ScmSource implements Source {
  readonly id: string;
  readonly kinds = [ciStatusChangedSpec, prHeadChangedSpec];
  private readonly lastStates: BoundedLru<string, { state: CiState; order: CiObservation['order'] }>;

  constructor(private readonly provider: ScmProvider, options: ScmSourceOptions = {}) {
    this.id = provider.id;
    this.lastStates = new BoundedLru(options.maxTrackedChecks ?? DEFAULT_MAX_TRACKED_CHECKS);
  }

  start(context: SourceContext): void | Promise<void> {
    return this.provider.start(
      { ci: (o) => this.onCi(context, o), prHead: (o) => this.onPrHead(context, o) },
      context.signal,
    );
  }

  private onCi(context: SourceContext, observation: CiObservation): ObservationOutcome {
    const subject = commitSubject(observation.repository, observation.sha);
    const trackingKey = JSON.stringify([subject.key, observation.check, observation.name]);
    const last = this.lastStates.get(trackingKey);
    if (last && isBefore(observation.order, last.order)) return 'stale';
    const from = last?.state ?? null;
    if (from === observation.state) {
      this.lastStates.set(trackingKey, { state: observation.state, order: observation.order });
      return 'no change';
    }

    const observedAt = new Date().toISOString();
    const event: RelayEvent<CiStatusChanged> = {
      id: `${this.id}:${observation.deliveryKey}`,
      kind: CI_STATUS_CHANGED,
      subject,
      occurredAt: observation.occurredAt ?? observedAt,
      observedAt,
      data: {
        repository: observation.repository,
        sha: observation.sha,
        check: observation.check,
        from,
        to: observation.state,
        detail: observation.detail,
        url: observation.url,
      },
      untrusted: { name: observation.name },
    };
    context.emit(event);
    this.lastStates.set(trackingKey, { state: observation.state, order: observation.order });
    return 'accepted';
  }

  private onPrHead(context: SourceContext, observation: PrHeadObservation): ObservationOutcome {
    if (observation.before === observation.sha) return 'no change';
    const subject = pullRequestSubject(observation.repository, observation.number);
    const observedAt = new Date().toISOString();
    const event: RelayEvent<PrHeadChanged> = {
      id: `${this.id}:pull_request:${subject.key}:${observation.before ?? 'none'}..${observation.sha}`,
      kind: PR_HEAD_CHANGED,
      subject,
      occurredAt: observation.occurredAt ?? observedAt,
      observedAt,
      data: {
        repository: observation.repository,
        number: observation.number,
        from: observation.before,
        to: observation.sha,
        url: observation.url,
      },
      untrusted: {},
    };
    context.emit(event);
    return 'accepted';
  }
}
