import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Relay, type RelayEvent, type SourceContext } from '../src/index';
import { parseConfig } from '../src/server/config';
import { RelayServer, type RelayServerOptions } from '../src/server/index';

const KIND = 'test.changed';

function event(id: string, key = 'a'): RelayEvent {
  return {
    id,
    kind: KIND,
    subject: { type: 'thing', key },
    occurredAt: '2026-01-01T00:00:00.000Z',
    observedAt: '2026-01-01T00:00:00.000Z',
    data: {},
    untrusted: {},
  };
}

interface Message {
  event: string;
  data: unknown;
}

const servers: Server[] = [];
const relayServers: RelayServer[] = [];

afterEach(async () => {
  for (const relayServer of relayServers.splice(0)) relayServer.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function setup(options: RelayServerOptions = {}) {
  const relay = new Relay({ minDeliveryIntervalMs: 0 });
  let context: SourceContext | undefined;
  await relay.addSource({ id: 'test', kinds: [{ kind: KIND, coalesceKey: () => null, overflow: 'drop-oldest' }], start: (ctx) => { context = ctx; } });
  const relayServer = new RelayServer(relay, options);
  const server = createServer(relayServer.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  relayServers.push(relayServer);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { relay, base, emit: (e: RelayEvent) => context!.emit(e) };
}

/** Reads Server-Sent Events from `url`, one message at a time. */
async function openEvents(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (): Promise<Message> => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (raw.startsWith(':')) continue;
        const field = (name: string) => raw.split('\n').find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
        return { event: field('event') ?? 'message', data: JSON.parse(field('data') ?? 'null') };
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffer += decoder.decode(value, { stream: true });
    }
  };
  return { response, next, close: () => controller.abort() };
}

const ids = (message: Message): string[] => (message.data as RelayEvent[]).map((e) => e.id);

describe('RelayServer', () => {
  it('answers /health', async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('starts each stream with its subscription id, then sends batches matching the filter', async () => {
    const { base, emit } = await setup();
    const stream = await openEvents(`${base}/events?kind=${KIND}&subject=thing:a`);

    expect(stream.response.headers.get('content-type')).toBe('text/event-stream');
    const first = await stream.next();
    expect(first.event).toBe('subscribed');
    expect(first.data).toEqual({ subscription: expect.any(String) });

    emit(event('1', 'b'));
    emit(event('2', 'a'));
    const batch = await stream.next();
    expect(batch.event).toBe('batch');
    expect(ids(batch)).toEqual(['2']);
    stream.close();
  });

  it('changes an open stream\'s filter', async () => {
    const { base, emit } = await setup();
    const stream = await openEvents(`${base}/events?subject=thing:a`);
    const { subscription } = (await stream.next()).data as { subscription: string };

    const response = await fetch(`${base}/subscriptions/${subscription}/filter`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjects: [{ type: 'thing', key: 'b' }] }),
    });
    expect(response.status).toBe(204);

    emit(event('1', 'a'));
    emit(event('2', 'b'));
    expect(ids(await stream.next())).toEqual(['2']);
    stream.close();
  });

  it('cancels the subscription when the client disconnects', async () => {
    const { relay, base } = await setup();
    const stream = await openEvents(`${base}/events`);
    const { subscription } = (await stream.next()).data as { subscription: string };

    stream.close();
    await expect.poll(() => relay.cancel(subscription)).toBe(false);
    const response = await fetch(`${base}/subscriptions/${subscription}/filter`, { method: 'PUT', body: '{}' });
    expect(response.status).toBe(404);
  });

  it('refuses a Host it does not serve, so a rebound DNS name cannot read the stream', async () => {
    const { base } = await setup();
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}/health`);
      request({ host: url.hostname, port: url.port, path: url.pathname, headers: { host: `evil.example:${url.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject).end();
    });
    expect(status).toBe(403);
  });

  it('requires the bearer token when one is set', async () => {
    const { base } = await setup({ token: 'secret' });
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect((await fetch(`${base}/health`, { headers: { authorization: 'Bearer wrong!' } })).status).toBe(401);
    expect((await fetch(`${base}/health`, { headers: { authorization: 'Bearer secret' } })).status).toBe(200);
  });

  it('answers 400 to a bad subject, interval or filter body', async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/events?subject=nokey`)).status).toBe(400);
    expect((await fetch(`${base}/events?minIntervalMs=soon`)).status).toBe(400);

    const stream = await openEvents(`${base}/events`);
    const { subscription } = (await stream.next()).data as { subscription: string };
    const put = (body: string) => fetch(`${base}/subscriptions/${subscription}/filter`, { method: 'PUT', body });
    expect((await put('not json')).status).toBe(400);
    expect((await put('{"kinds":"ci"}')).status).toBe(400);
    expect((await put('{"subjects":[{"type":"thing"}]}')).status).toBe(400);
    stream.close();
  });

  it('answers 404 to an unknown path and 405 to a wrong method', async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/events`, { method: 'POST' })).status).toBe(405);
  });
});

describe('parseConfig', () => {
  const env = { GITHUB_TOKEN: 'gh', AZURE_DEVOPS_TOKEN: 'ado' };

  it('reads sources from the file and tokens from the environment', () => {
    const config = parseConfig(
      { github: { repositories: ['o/r'] }, azureDevOps: { organizationUrl: 'https://dev.azure.com/org', repositories: ['p/r'], intervalMs: 60_000 }, limits: { maxSubscriptions: 5 } },
      env,
    );
    expect(config).toEqual({
      host: '127.0.0.1',
      port: 8787,
      token: undefined,
      allowedHosts: undefined,
      github: { repositories: ['o/r'], apiUrl: undefined, intervalMs: undefined, token: 'gh' },
      azureDevOps: { organizationUrl: 'https://dev.azure.com/org', repositories: ['p/r'], intervalMs: 60_000, token: 'ado' },
      limits: { maxSubscriptions: 5 },
    });
  });

  it('refuses a configured source without its token', () => {
    expect(() => parseConfig({ github: { repositories: ['o/r'] } }, {})).toThrow('GITHUB_TOKEN');
  });

  it('refuses to listen beyond loopback without EVENT_RELAY_TOKEN', () => {
    expect(() => parseConfig({ host: '0.0.0.0', github: { repositories: ['o/r'] } }, env)).toThrow('EVENT_RELAY_TOKEN');
    expect(parseConfig({ host: '0.0.0.0', github: { repositories: ['o/r'] } }, { ...env, EVENT_RELAY_TOKEN: 't' }).token).toBe('t');
  });

  it('refuses a config with no source, an unknown limit or a bad port', () => {
    expect(() => parseConfig({}, env)).toThrow('at least one');
    expect(() => parseConfig({ github: { repositories: ['o/r'] }, limits: { maxEverything: 1 } }, env)).toThrow('limits.maxEverything');
    expect(() => parseConfig({ github: { repositories: ['o/r'] }, port: 70_000 }, env)).toThrow('port');
  });
});
