// Lakebase OAuth database-credential minting.
//
// Lakebase Postgres authenticates with a short-lived (~60 min) OAuth database
// credential used as the Postgres password. node-postgres asks for a password
// on every new connection, so the pg worker hands it `provider()` from this
// module as its async `password` callback; tokens are cached until shortly
// before they expire so a reconnect storm does not mint one per connection.
//
// Two minting paths, chosen by `source`:
//   - 'rest': POST {workspace}/api/2.0/postgres/credentials with a workspace
//     OAuth token. The workspace token comes from DATABRICKS_TOKEN, or from the
//     Databricks Apps service principal (DATABRICKS_CLIENT_ID/SECRET) via the
//     OIDC client_credentials flow.
//   - 'cli':  `databricks postgres generate-database-credential <endpoint>`.
//
// This file is loaded inside the pg worker thread (see pg-worker.ts), which
// runs without the TypeScript build's import rewriting. Keep it free of
// relative imports and non-erasable TypeScript syntax.

import { execFile } from 'node:child_process';

export interface LakebaseCredentialConfig {
  source: 'rest' | 'cli';
  /** Lakebase endpoint resource: projects/{p}/branches/{b}/endpoints/{e}. */
  endpoint: string;
  /** Workspace URL (DATABRICKS_HOST); required for the REST path. */
  workspaceHost: string | null;
  workspaceToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  cliPath: string;
  cliProfile: string | null;
}

export interface LakebaseCredentialDeps {
  fetch?: typeof fetch;
  runCli?: (file: string, args: string[]) => Promise<string>;
  now?: () => number;
}

interface MintedCredential {
  token: string;
  expiresAt: number;
}

// Refresh this long before the server-reported expiry.
const REFRESH_MARGIN_MS = 5 * 60_000;
// Assumed lifetime when the server does not report one.
const DEFAULT_TTL_MS = 55 * 60_000;

export function normalizeWorkspaceHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function defaultRunCli(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${file} ${args.slice(0, 2).join(' ')} failed: ${String(stderr || error.message).trim()}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

function parseExpiry(value: unknown, now: number): number {
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now + DEFAULT_TTL_MS;
}

async function workspaceOAuthToken(
  config: LakebaseCredentialConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (config.workspaceToken) return config.workspaceToken;
  if (!config.workspaceHost || !config.clientId || !config.clientSecret) {
    throw new Error(
      'Lakebase REST credential minting needs DATABRICKS_HOST plus DATABRICKS_TOKEN or ' +
        'DATABRICKS_CLIENT_ID/DATABRICKS_CLIENT_SECRET.',
    );
  }
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetchImpl(`${normalizeWorkspaceHost(config.workspaceHost)}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=all-apis',
  });
  if (!response.ok) {
    throw new Error(`Databricks OIDC token request failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error('Databricks OIDC token response had no access_token');
  }
  return body.access_token;
}

async function mintViaRest(
  config: LakebaseCredentialConfig,
  fetchImpl: typeof fetch,
  now: number,
): Promise<MintedCredential> {
  if (!config.workspaceHost) {
    throw new Error('Lakebase REST credential minting needs DATABRICKS_HOST.');
  }
  const bearer = await workspaceOAuthToken(config, fetchImpl);
  const response = await fetchImpl(
    `${normalizeWorkspaceHost(config.workspaceHost)}/api/2.0/postgres/credentials`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: config.endpoint }),
    },
  );
  if (!response.ok) {
    throw new Error(`Lakebase credential request failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { token?: unknown; expire_time?: unknown };
  if (typeof body.token !== 'string' || !body.token) {
    throw new Error('Lakebase credential response had no token');
  }
  return { token: body.token, expiresAt: parseExpiry(body.expire_time, now) };
}

async function mintViaCli(
  config: LakebaseCredentialConfig,
  runCli: (file: string, args: string[]) => Promise<string>,
  now: number,
): Promise<MintedCredential> {
  const args = ['postgres', 'generate-database-credential', config.endpoint, '-o', 'json'];
  if (config.cliProfile) args.push('--profile', config.cliProfile);
  const stdout = await runCli(config.cliPath, args);
  let body: { token?: unknown; expire_time?: unknown };
  try {
    body = JSON.parse(stdout) as typeof body;
  } catch {
    throw new Error('databricks postgres generate-database-credential did not print JSON');
  }
  if (typeof body.token !== 'string' || !body.token) {
    throw new Error('databricks postgres generate-database-credential returned no token');
  }
  return { token: body.token, expiresAt: parseExpiry(body.expire_time, now) };
}

/**
 * Build the async password callback for node-postgres. Each call returns a
 * credential valid for at least REFRESH_MARGIN_MS; concurrent callers share
 * one in-flight mint.
 */
export function createLakebasePasswordProvider(
  config: LakebaseCredentialConfig,
  deps: LakebaseCredentialDeps = {},
): () => Promise<string> {
  const fetchImpl = deps.fetch ?? fetch;
  const runCli = deps.runCli ?? defaultRunCli;
  const clock = deps.now ?? Date.now;
  let cached: MintedCredential | null = null;
  let inflight: Promise<MintedCredential> | null = null;

  return async () => {
    const now = clock();
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now) return cached.token;
    if (!inflight) {
      inflight = (config.source === 'cli'
        ? mintViaCli(config, runCli, now)
        : mintViaRest(config, fetchImpl, now)
      ).finally(() => {
        inflight = null;
      });
    }
    cached = await inflight;
    return cached.token;
  };
}
