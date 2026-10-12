import { execFile } from 'node:child_process';
import { Unexpected } from '../scm/poll';

/** Azure DevOps' resource id in Microsoft Entra ID, which `az` asks tokens for. */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
/** A token this close to expiring is replaced before use. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Runs `az` with these arguments and resolves with its stdout. */
export type RunAzureCli = (args: readonly string[]) => Promise<string>;

export interface Credential {
  /** The Authorization header value. */
  header(): Promise<string>;
  /** Called after the host rejected the header; true if trying again with a new one can help. */
  rejected(): boolean;
}

export function personalAccessToken(token: string): Credential {
  const header = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  return { header: async () => header, rejected: () => false };
}

/**
 * Tokens from the Azure CLI's signed-in account (`az login`). `az` refreshes
 * them with its own refresh token; this asks for a new one shortly before the
 * current one expires, or after the host rejected it.
 */
export function azureCli(run: RunAzureCli = runAzureCli, now: () => number = Date.now): Credential {
  let cached: { header: string; expiresAt: number } | null = null;
  return {
    async header() {
      if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached.header;
      let output: string;
      try {
        output = await run(['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, '--output', 'json']);
      } catch (error) {
        throw new Unexpected(`az account get-access-token failed; is the Azure CLI installed and signed in (az login)? ${error instanceof Error ? error.message : ''}`.trim(), { cause: error });
      }
      const parsed: unknown = JSON.parse(output);
      const token = typeof parsed === 'object' && parsed !== null ? (parsed as { accessToken?: unknown; expires_on?: unknown }) : {};
      if (typeof token.accessToken !== 'string' || typeof token.expires_on !== 'number') {
        throw new Unexpected('az account get-access-token returned no accessToken and expires_on');
      }
      cached = { header: `Bearer ${token.accessToken}`, expiresAt: token.expires_on * 1000 };
      return cached.header;
    },
    rejected() {
      const hadToken = cached !== null;
      cached = null;
      return hadToken;
    },
  };
}

function runAzureCli(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // az is a .cmd script on Windows, which only a shell can start.
    execFile('az', [...args], { timeout: 60_000, shell: process.platform === 'win32' }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}
