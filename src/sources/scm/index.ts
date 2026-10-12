import type { RelayEvent, Source, SourceContext } from '../../contract';
import { BoundedLru } from '../../core/boundedLru';
import {
  CI_STATUS_CHANGED,
  ciStatusChangedSpec,
  commitSubject,
  PR_CLOSED,
  PR_COMMENT_ADDED,
  PR_HEAD_CHANGED,
  PR_MERGEABILITY_CHANGED,
  PR_REVIEW_SUBMITTED,
  prClosedSpec,
  prCommentAddedSpec,
  prHeadChangedSpec,
  prMergeabilityChangedSpec,
  prReviewSubmittedSpec,
  pullRequestSubject,
  type CiState,
  type CiStatusChanged,
  type Mergeability,
  type PrClosed,
  type PrCommentAdded,
  type PrHeadChanged,
  type PrMergeabilityChanged,
  type PrReviewSubmitted,
} from '../../kinds';
import type {
  CiObservation,
  CommentObservation,
  MergeabilityObservation,
  ObservationOutcome,
  PrClosedObservation,
  PrHeadObservation,
  ReviewObservation,
  ScmProvider,
} from './provider';

export type {
  CiObservation,
  CommentObservation,
  MergeabilityObservation,
  ObservationOutcome,
  PrClosedObservation,
  PrHeadObservation,
  ReviewObservation,
  ScmObserver,
  ScmProvider,
} from './provider';

export interface ScmSourceOptions {
  /** Checks whose last state is remembered to suppress repeats. */
  maxTrackedChecks?: number;
  /** Pull requests whose mergeability, and reviews and comments already reported, are remembered to suppress repeats. */
  maxTrackedPullRequestItems?: number;
}

const DEFAULT_MAX_TRACKED_CHECKS = 10_000;
const DEFAULT_MAX_TRACKED_PULL_REQUEST_ITEMS = 10_000;

const isBefore = (a: CiObservation['order'], b: CiObservation['order']): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/**
 * Emits `ci.status_changed`, `pr.head_changed`, `pr.closed`,
 * `pr.review_submitted`, `pr.comment_added` and `pr.mergeability_changed` from a
 * code host's observations, whichever host the provider talks to.
 *
 * A check is reported only when its CiState changes, and an update older than
 * the last one reported for that check is dropped, so a late `in_progress`
 * never follows its `completed`.
 */
export class ScmSource implements Source {
  readonly id: string;
  readonly kinds = [ciStatusChangedSpec, prHeadChangedSpec, prClosedSpec, prReviewSubmittedSpec, prCommentAddedSpec, prMergeabilityChangedSpec];
  private readonly lastStates: BoundedLru<string, { state: CiState; order: CiObservation['order'] }>;
  private readonly lastMergeability: BoundedLru<string, Mergeability>;
  /** Reviews and comments already reported; a provider may report one more than once. */
  private readonly reported: BoundedLru<string, true>;

  constructor(private readonly provider: ScmProvider, options: ScmSourceOptions = {}) {
    this.id = provider.id;
    this.lastStates = new BoundedLru(options.maxTrackedChecks ?? DEFAULT_MAX_TRACKED_CHECKS);
    const items = options.maxTrackedPullRequestItems ?? DEFAULT_MAX_TRACKED_PULL_REQUEST_ITEMS;
    this.lastMergeability = new BoundedLru(items);
    this.reported = new BoundedLru(items);
  }

  start(context: SourceContext): void | Promise<void> {
    return this.provider.start(
      {
        ci: (o) => this.onCi(context, o),
        prHead: (o) => this.onPrHead(context, o),
        prClosed: (o) => this.onPrClosed(context, o),
        review: (o) => this.onReview(context, o),
        comment: (o) => this.onComment(context, o),
        mergeability: (o) => this.onMergeability(context, o),
      },
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

  private onPrClosed(context: SourceContext, observation: PrClosedObservation): ObservationOutcome {
    const subject = pullRequestSubject(observation.repository, observation.number);
    const event: RelayEvent<PrClosed> = {
      id: `${this.id}:pull_request:${subject.key}:closed@${observation.closedAt}`,
      kind: PR_CLOSED,
      subject,
      occurredAt: observation.closedAt,
      observedAt: new Date().toISOString(),
      data: {
        repository: observation.repository,
        number: observation.number,
        merged: observation.merged,
        head: observation.sha,
        url: observation.url,
      },
      untrusted: {},
    };
    context.emit(event);
    return 'accepted';
  }
  private onReview(context: SourceContext, observation: ReviewObservation): ObservationOutcome {
    const subject = pullRequestSubject(observation.repository, observation.number);
    const id = `${this.id}:review:${subject.key}:${observation.reviewId}`;
    if (this.reported.get(id)) return 'no change';
    const observedAt = new Date().toISOString();
    const event: RelayEvent<PrReviewSubmitted> = {
      id,
      kind: PR_REVIEW_SUBMITTED,
      subject,
      occurredAt: observation.submittedAt ?? observedAt,
      observedAt,
      data: { repository: observation.repository, number: observation.number, reviewId: observation.reviewId, state: observation.state, url: observation.url },
      untrusted: { author: observation.author },
    };
    context.emit(event);
    this.reported.set(id, true);
    return 'accepted';
  }

  private onComment(context: SourceContext, observation: CommentObservation): ObservationOutcome {
    const subject = pullRequestSubject(observation.repository, observation.number);
    const id = `${this.id}:comment:${subject.key}:${observation.commentId}`;
    if (this.reported.get(id)) return 'no change';
    const observedAt = new Date().toISOString();
    const event: RelayEvent<PrCommentAdded> = {
      id,
      kind: PR_COMMENT_ADDED,
      subject,
      occurredAt: observation.createdAt ?? observedAt,
      observedAt,
      data: { repository: observation.repository, number: observation.number, commentId: observation.commentId, url: observation.url },
      untrusted: { author: observation.author },
    };
    context.emit(event);
    this.reported.set(id, true);
    return 'accepted';
  }

  private onMergeability(context: SourceContext, observation: MergeabilityObservation): ObservationOutcome {
    const subject = pullRequestSubject(observation.repository, observation.number);
    const from = this.lastMergeability.get(subject.key) ?? null;
    if (from === observation.state) return 'no change';
    const observedAt = new Date().toISOString();
    const event: RelayEvent<PrMergeabilityChanged> = {
      id: `${this.id}:mergeability:${subject.key}:${from ?? 'none'}..${observation.state}@${observedAt}`,
      kind: PR_MERGEABILITY_CHANGED,
      subject,
      occurredAt: observedAt,
      observedAt,
      data: { repository: observation.repository, number: observation.number, from, to: observation.state, url: observation.url },
      untrusted: {},
    };
    context.emit(event);
    this.lastMergeability.set(subject.key, observation.state);
    return 'accepted';
  }
}
