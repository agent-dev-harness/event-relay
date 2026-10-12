import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Sink, Subject, SubscriptionFilter } from '../contract';
import type { Relay } from '../core/relay';

export interface RelayServerOptions {
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  token?: string;
  /**
   * Host header names (without port) the server answers. A page in a browser can
   * point a name it controls at 127.0.0.1 (DNS rebinding); checking Host stops it
   * reading the stream.
   */
  allowedHosts?: readonly string[];
  /** How often an idle stream gets a comment, so proxies and clients see it is alive. */
  keepAliveMs?: number;
}

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
const DEFAULT_KEEP_ALIVE_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;

interface Stream {
  sink: Sink;
  minIntervalMs: number | undefined;
  close(): void;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Serves a Relay over HTTP to subscribers in other processes. Each
 * `GET /events` stream is one subscription, sent as Server-Sent Events; the
 * endpoints are specified in docs/server.md.
 */
export class RelayServer {
  private readonly streams = new Map<string, Stream>();
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly keepAliveMs: number;
  private readonly token: Buffer | null;

  constructor(private readonly relay: Relay, options: RelayServerOptions = {}) {
    if (options.token === '') throw new Error('token must not be empty; leave it out to accept requests without one');
    this.token = options.token === undefined ? null : Buffer.from(options.token);
    this.allowedHosts = new Set((options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((host) => host.toLowerCase()));
    this.keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  }

  /** A node:http request handler. */
  readonly handler = (req: IncomingMessage, res: ServerResponse): void => {
    this.route(req, res).catch((error: unknown) => {
      const status = error instanceof RequestError ? error.status : 500;
      const message = error instanceof Error ? error.message : 'internal error';
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    });
  };

  /** Ends every open stream. Their subscriptions are cancelled. */
  close(): void {
    for (const stream of this.streams.values()) stream.close();
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowedHosts.has(hostName(req.headers.host))) throw new RequestError(403, 'host not allowed');
    if (!this.isAuthorized(req.headers.authorization)) throw new RequestError(401, 'missing or wrong bearer token');

    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    const filterPath = /^\/subscriptions\/([^/]+)\/filter$/.exec(url.pathname);
    if (url.pathname === '/health') {
      allowMethod(req, 'GET');
      sendJson(res, 200, { ok: true });
    } else if (url.pathname === '/events') {
      allowMethod(req, 'GET');
      this.openStream(url.searchParams, res);
    } else if (filterPath) {
      allowMethod(req, 'PUT');
      await this.changeFilter(decodeURIComponent(filterPath[1]!), req, res);
    } else {
      throw new RequestError(404, 'not found');
    }
  }

  private openStream(query: URLSearchParams, res: ServerResponse): void {
    const filter = filterFrom(query.getAll('kind'), query.getAll('subject').map(parseSubject));
    const interval = query.get('minIntervalMs');
    const minIntervalMs = interval === null ? undefined : Number(interval);

    const id = randomUUID();
    const sink: Sink = { deliver: (batch) => write(res, `event: batch\ndata: ${JSON.stringify(batch)}\n\n`) };
    try {
      this.relay.subscribe(id, { filter, sink, minIntervalMs });
    } catch (error) {
      throw new RequestError(400, error instanceof Error ? error.message : 'subscription refused');
    }

    const keepAlive = setInterval(() => void write(res, ': keep-alive\n\n').catch(() => {}), this.keepAliveMs);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      this.relay.cancel(id);
      this.streams.delete(id);
      res.end();
    };
    this.streams.set(id, { sink, minIntervalMs, close });
    res.on('close', close);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    void write(res, `event: subscribed\ndata: ${JSON.stringify({ subscription: id })}\n\n`).catch(close);
  }

  private async changeFilter(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const stream = this.streams.get(id);
    if (!stream) throw new RequestError(404, 'no open stream with this subscription id');
    const body = await readJson(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new RequestError(400, 'body must be a JSON object');
    const { kinds, subjects } = body as { kinds?: unknown; subjects?: unknown };
    if (kinds !== undefined && !(Array.isArray(kinds) && kinds.every((k) => typeof k === 'string'))) {
      throw new RequestError(400, 'kinds must be an array of strings');
    }
    if (subjects !== undefined && !(Array.isArray(subjects) && subjects.every(isSubject))) {
      throw new RequestError(400, 'subjects must be an array of { type, key } strings');
    }
    this.relay.subscribe(id, { filter: filterFrom(kinds ?? [], subjects ?? []), sink: stream.sink, minIntervalMs: stream.minIntervalMs });
    res.writeHead(204).end();
  }

  private isAuthorized(header: string | undefined): boolean {
    if (this.token === null) return true;
    const match = /^Bearer (.+)$/.exec(header ?? '');
    if (!match) return false;
    const given = Buffer.from(match[1]!);
    return given.length === this.token.length && timingSafeEqual(given, this.token);
  }
}

/** An empty list means "everything", as leaving the field out does in SubscriptionFilter. */
function filterFrom(kinds: readonly string[], subjects: readonly Subject[]): SubscriptionFilter {
  return { ...(kinds.length > 0 ? { kinds } : {}), ...(subjects.length > 0 ? { subjects } : {}) };
}

/** `<type>:<key>`; the type has no colon, the key may. */
function parseSubject(value: string): Subject {
  const colon = value.indexOf(':');
  if (colon <= 0 || colon === value.length - 1) throw new RequestError(400, `subject "${value}" is not <type>:<key>`);
  return { type: value.slice(0, colon), key: value.slice(colon + 1) };
}

function isSubject(value: unknown): value is Subject {
  if (typeof value !== 'object' || value === null) return false;
  const { type, key } = value as { type?: unknown; key?: unknown };
  return typeof type === 'string' && typeof key === 'string' && type !== '' && key !== '';
}

/** The Host header without its port; "[::1]:8787" → "[::1]". */
function hostName(host: string | undefined): string {
  if (host === undefined) return '';
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  return name.toLowerCase();
}

function allowMethod(req: IncomingMessage, method: string): void {
  if (req.method !== method) throw new RequestError(405, `${method} only`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** Resolves once the chunk is handed to the OS; rejects if the stream is gone. */
function write(res: ServerResponse, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (res.writableEnded || res.destroyed) {
      reject(new Error('stream closed'));
      return;
    }
    res.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'body is not JSON');
  }
}
