import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KindSpec, RelayEvent, Source, SourceContext } from '../../contract';
import { BoundedLru } from '../../core/boundedLru';
import { readCiObservation } from './normalize';

export const CI_STATUS_CHANGED = 'ci.status_changed';

/** `data` of a `ci.status_changed` event. Its subject is `{ type: "commit", key: "<owner>/<repo>@<sha>" }`. */
export interface CiStatusChanged {
  check: 'check_run' | 'status';
  repository: string;
  sha: string;
  /** null when the source hasn't seen this check on this commit before, or has forgotten it. */
  from: string | null;
  to: string;
  url: string | null;
  /** Same-repository PRs GitHub reported for a check run; always empty for a commit status. */
  pullRequests: number[];
}

const ciStatusChangedSpec: KindSpec = {
  kind: CI_STATUS_CHANGED,
  // The relay calls this only with events of this kind, which only this source creates.
  coalesceKey: (event) => `${event.subject.key}|${(event.data as CiStatusChanged).check}|${event.untrusted.name}`,
  overflow: 'drop-oldest',
};

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

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_TRACKED_CHECKS = 10_000;

/**
 * Emits `ci.status_changed` from GitHub `check_run` and `status` webhooks. Host
 * `handler` on an HTTP server, or pass deliveries to `receive` yourself.
 */
export class GitHubSource implements Source {
  readonly id = 'github';
  readonly kinds = [ciStatusChangedSpec];
  private readonly secret: string;
  private readonly maxPayloadBytes: number;
  private readonly lastStates: BoundedLru<string, string>;
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

    const observation = readCiObservation(delivery.eventName, payload);
    if (!observation) return { status: 202, message: 'ignored' };

    const subjectKey = `${observation.repository}@${observation.sha}`;
    const trackingKey = JSON.stringify([subjectKey, observation.check, observation.name]);
    const from = this.lastStates.get(trackingKey) ?? null;
    if (from === observation.state) return { status: 202, message: 'no change' };
    this.lastStates.set(trackingKey, observation.state);

    const observedAt = new Date().toISOString();
    const event: RelayEvent<CiStatusChanged> = {
      id: `github:${observation.deliveryKey}`,
      kind: CI_STATUS_CHANGED,
      subject: { type: 'commit', key: subjectKey },
      occurredAt: observation.occurredAt ?? observedAt,
      observedAt,
      data: {
        check: observation.check,
        repository: observation.repository,
        sha: observation.sha,
        from,
        to: observation.state,
        url: observation.url,
        pullRequests: observation.pullRequests,
      },
      untrusted: { name: observation.name },
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
