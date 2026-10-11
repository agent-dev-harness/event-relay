import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ObservationOutcome, ScmObserver, ScmProvider } from '../scm/provider';
import { readCiObservation, readPrClosedObservation, readPrHeadObservation } from './normalize';

export interface GitHubProviderOptions {
  webhookSecret: string;
  /** Bodies larger than this are refused before they are parsed. */
  maxPayloadBytes?: number;
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
  message: ObservationOutcome | 'ignored' | 'source is not running' | 'payload too large' | 'bad signature' | 'body is not JSON' | 'POST only';
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Turns GitHub `check_run`, `status` and `pull_request` (opened, reopened,
 * synchronize, closed) webhooks into observations for an ScmSource. Host `handler` on an HTTP server, or pass
 * deliveries to `receive` yourself.
 */
export class GitHubProvider implements ScmProvider {
  readonly id = 'github';
  private readonly secret: string;
  private readonly maxPayloadBytes: number;
  private observer: ScmObserver | undefined;
  private signal: AbortSignal | undefined;

  constructor(options: GitHubProviderOptions) {
    if (options.webhookSecret === '') throw new Error('webhookSecret must not be empty');
    this.secret = options.webhookSecret;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  }

  start(observer: ScmObserver, signal: AbortSignal): void {
    this.observer = observer;
    this.signal = signal;
  }

  receive(delivery: WebhookDelivery): WebhookResponse {
    const observer = this.observer;
    if (!observer || this.signal?.aborted) return { status: 503, message: 'source is not running' };
    if (delivery.body.length > this.maxPayloadBytes) return { status: 413, message: 'payload too large' };
    if (!this.hasValidSignature(delivery)) return { status: 401, message: 'bad signature' };

    let payload: unknown;
    try {
      payload = JSON.parse(delivery.body.toString('utf8'));
    } catch {
      return { status: 400, message: 'body is not JSON' };
    }

    const ci = readCiObservation(delivery.eventName, payload);
    if (ci) return { status: 202, message: observer.ci(ci) };
    const prHead = readPrHeadObservation(delivery.eventName, payload);
    if (prHead) return { status: 202, message: observer.prHead(prHead) };
    const prClosed = readPrClosedObservation(delivery.eventName, payload);
    if (prClosed) return { status: 202, message: observer.prClosed(prClosed) };
    return { status: 202, message: 'ignored' };
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
