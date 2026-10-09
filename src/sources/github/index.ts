import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
import { readCiObservation, readPrHeadObservation, type CiObservation, type PrHeadObservation } from './normalize';

export interface GitHubSourceOptions {
  webhookSecret: string;
  /** Bodies larger than this are refused before they are parsed. */
  maxPayloadBytes?: number;
  /** Checks whose last state is remembered to suppress repeats. */
  maxTrackedChecks?: number;
}

export interface WebhookDelivery {
  /** The X-GitHub-Event header. */
  eventName: string;
  /** The X-Hub-Signature-256 header. */
  signature: string | undefined;
  body: Buffer;
}

export interface WebhookResponse {
  status: number;
  message: string;
}

const isBefore = (a: CiObservation['order'], b: CiObservation['order']): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_TRACKED_CHECKS = 10_000;

/**
 * Emits `ci.status_changed` from GitHub `check_run` and `status` webhooks, and
 * `pr.head_changed` from `pull_request` webhooks. Host
 * `handler` on an HTTP server, or pass deliveries to `receive` yourself.
 *
 * A check is reported only when its CiState changes, and an update older than
 * the last one reported for that check is dropped, so a late `in_progress`
 * never follows its `completed`.
 */
export class GitHubSource implements Source {
  readonly id = 'github';
  readonly kinds = [ciStatusChangedSpec, prHeadChangedSpec];
  private readonly secret: string;
  private readonly maxPayloadBytes: number;
  private readonly lastStates: BoundedLru<string, { state: CiState; order: CiObservation['order'] }>;
  private context: SourceContext | undefined;

  constructor(options: GitHubSourceOptions) {
    if (options.webhookSecret === '') throw new Error('webhookSecret must not be empty');
    this.secret = options.webhookSecret;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.lastStates = new BoundedLru(options.maxTrackedChecks ?? DEFAULT_MAX_TRACKED_CHECKS);
  }

  start(context: SourceContext): void {
    this.context = context;
  }

  receive(delivery: WebhookDelivery): WebhookResponse {
    const context = this.context;
    if (!context || context.signal.aborted) return { status: 503, message: 'source is not running' };
    if (delivery.body.length > this.maxPayloadBytes) return { status: 413, message: 'payload too large' };
    if (!this.hasValidSignature(delivery)) return { status: 401, message: 'bad signature' };

    let payload: unknown;
    try {
      payload = JSON.parse(delivery.body.toString('utf8'));
    } catch {
      return { status: 400, message: 'body is not JSON' };
    }

    const ci = readCiObservation(delivery.eventName, payload);
    if (ci) return this.emitCiChange(context, ci);
    const prHead = readPrHeadObservation(delivery.eventName, payload);
    if (prHead) return this.emitPrHeadChange(context, prHead);
    return { status: 202, message: 'ignored' };
  }

  private emitCiChange(context: SourceContext, observation: CiObservation): WebhookResponse {
    const subject = commitSubject(observation.repository, observation.sha);
    const trackingKey = JSON.stringify([subject.key, observation.check, observation.name]);
    const last = this.lastStates.get(trackingKey);
    if (last && isBefore(observation.order, last.order)) return { status: 202, message: 'stale' };
    const from = last?.state ?? null;
    if (from === observation.state) {
      this.lastStates.set(trackingKey, { state: observation.state, order: observation.order });
      return { status: 202, message: 'no change' };
    }

    const observedAt = new Date().toISOString();
    const event: RelayEvent<CiStatusChanged> = {
      id: `github:${observation.deliveryKey}`,
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
    return { status: 202, message: 'accepted' };
  }

  private emitPrHeadChange(context: SourceContext, observation: PrHeadObservation): WebhookResponse {
    if (observation.before === observation.sha) return { status: 202, message: 'no change' };
    const subject = pullRequestSubject(observation.repository, observation.number);
    const observedAt = new Date().toISOString();
    const event: RelayEvent<PrHeadChanged> = {
      id: `github:pull_request:${subject.key}:${observation.before ?? 'none'}..${observation.sha}`,
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
    return { status: 202, message: 'accepted' };
  }

  /** A node:http request handler for the webhook endpoint. It stops reading a body once it passes maxPayloadBytes. */
  readonly handler = (req: IncomingMessage, res: ServerResponse): void => {
    const reply = ({ status, message }: WebhookResponse): void => {
      res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' }).end(message);
    };
    if (req.method !== 'POST') {
      reply({ status: 405, message: 'POST only' });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > this.maxPayloadBytes) {
        refused = true;
        chunks.length = 0;
        reply({ status: 413, message: 'payload too large' });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (refused) return;
      const header = (name: string): string | undefined => {
        const value = req.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      reply(this.receive({
        eventName: header('x-github-event') ?? '',
        signature: header('x-hub-signature-256'),
        body: Buffer.concat(chunks),
      }));
    });
  };

  private hasValidSignature({ signature, body }: WebhookDelivery): boolean {
    if (signature === undefined) return false;
    const expected = Buffer.from(`sha256=${createHmac('sha256', this.secret).update(body).digest('hex')}`);
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
