#!/usr/bin/env node
// Runs the relay as a local server: `event-relay-server <config.json>`. See docs/server.md.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Relay } from '../core/relay';
import { AzureDevOpsPoller } from '../sources/azure-devops/index';
import { GitHubPoller } from '../sources/github/poller';
import { ScmSource } from '../sources/scm/index';
import { parseConfig } from './config';
import { DEFAULT_ALLOWED_HOSTS, RelayServer } from './index';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: event-relay-server <config.json>');
  process.exit(2);
}

const config = parseConfig(JSON.parse(readFileSync(path, 'utf8')), process.env);
const logError = (source: string) => (error: unknown): void => console.error(`[${source}]`, error instanceof Error ? error.message : error);
// A source that stopped polling can't see its host; staying up would look like a host where nothing happens.
const exitOnFatal = (source: string) => (error: unknown): void => {
  console.error(`[${source}] stopped polling:`, error instanceof Error ? error.message : error);
  process.exit(1);
};

const relay = new Relay(config.limits);
if (config.github) {
  await relay.addSource(new ScmSource(new GitHubPoller({ ...config.github, onError: logError('github'), onFatal: exitOnFatal('github') })));
}
if (config.azureDevOps) {
  await relay.addSource(new ScmSource(new AzureDevOpsPoller({ ...config.azureDevOps, onError: logError('azure-devops'), onFatal: exitOnFatal('azure-devops') })));
}

const relayServer = new RelayServer(relay, {
  token: config.token,
  allowedHosts: config.allowedHosts ?? [...DEFAULT_ALLOWED_HOSTS, config.host],
});
const server = createServer(relayServer.handler);
server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  console.error(`event-relay listening on http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`);
});

const shutdown = (): void => {
  relayServer.close();
  relay.stop();
  server.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
