import type { RelayLimits } from '../core/limits';

export interface ServerConfig {
  host: string;
  port: number;
  /** From EVENT_RELAY_TOKEN; subscribers must send it as a Bearer token. */
  token: string | undefined;
  allowedHosts: string[] | undefined;
  github: { repositories: string[]; apiUrl: string | undefined; intervalMs: number | undefined; token: string } | undefined;
  azureDevOps: { organizationUrl: string; repositories: string[]; intervalMs: number | undefined; token: string } | undefined;
  limits: Partial<RelayLimits>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const LIMIT_NAMES: readonly (keyof RelayLimits)[] = [
  'maxSubscriptions',
  'maxQueuedEventsPerSubscriber',
  'maxGapSubjectsPerSubscriber',
  'maxEventBytes',
  'maxDedupeIds',
  'minDeliveryIntervalMs',
  'deliveryTimeoutMs',
];

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function optionalObject(parent: Json, key: string): Json | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`${key} must be an object`);
  return value;
}

function optionalString(parent: Json, key: string, where: string): string | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw new Error(`${where}${key} must be a non-empty string`);
  return value;
}

function optionalNumber(parent: Json, key: string, where: string): number | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where}${key} must be a number`);
  return value;
}

function stringList(parent: Json, key: string, where: string): string[] {
  const value = parent[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string' && item !== '')) {
    throw new Error(`${where}${key} must be a non-empty array of strings`);
  }
  return value as string[];
}

function secret(env: Readonly<Record<string, string | undefined>>, name: string, needed: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} must be set when ${needed} is configured`);
  return value;
}

/**
 * Reads the server's JSON config. Tokens come from the environment, never the
 * file, so the file can be committed.
 */
export function parseConfig(json: unknown, env: Readonly<Record<string, string | undefined>>): ServerConfig {
  if (!isObject(json)) throw new Error('config must be a JSON object');
  const host = optionalString(json, 'host', '') ?? DEFAULT_HOST;
  const port = optionalNumber(json, 'port', '') ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('port must be an integer from 0 to 65535');
  const token = env.EVENT_RELAY_TOKEN === '' ? undefined : env.EVENT_RELAY_TOKEN;
  // Anyone who can reach the port can read every configured repository's events.
  if (!LOOPBACK.has(host) && token === undefined) throw new Error(`EVENT_RELAY_TOKEN must be set to listen on ${host}, which is not loopback`);
  const allowedHosts = json.allowedHosts === undefined ? undefined : stringList(json, 'allowedHosts', '');

  const githubJson = optionalObject(json, 'github');
  const github = githubJson && {
    repositories: stringList(githubJson, 'repositories', 'github.'),
    apiUrl: optionalString(githubJson, 'apiUrl', 'github.'),
    intervalMs: optionalNumber(githubJson, 'intervalMs', 'github.'),
    token: secret(env, 'GITHUB_TOKEN', 'github'),
  };

  const adoJson = optionalObject(json, 'azureDevOps');
  const organizationUrl = adoJson && optionalString(adoJson, 'organizationUrl', 'azureDevOps.');
  if (adoJson && organizationUrl === undefined) throw new Error('azureDevOps.organizationUrl must be set');
  const azureDevOps = adoJson && organizationUrl !== undefined ? {
    organizationUrl,
    repositories: stringList(adoJson, 'repositories', 'azureDevOps.'),
    intervalMs: optionalNumber(adoJson, 'intervalMs', 'azureDevOps.'),
    token: secret(env, 'AZURE_DEVOPS_TOKEN', 'azureDevOps'),
  } : undefined;
  if (!github && !azureDevOps) throw new Error('configure at least one of github and azureDevOps');

  const limitsJson = optionalObject(json, 'limits') ?? {};
  const limits: Partial<RelayLimits> = {};
  for (const key of Object.keys(limitsJson)) {
    const name = LIMIT_NAMES.find((limit) => limit === key);
    if (name === undefined) throw new Error(`limits.${key} is not a relay limit`);
    limits[name] = optionalNumber(limitsJson, key, 'limits.');
  }

  return { host, port, token, allowedHosts, github, azureDevOps, limits };
}
