import { execFile } from 'node:child_process';

// Lets `od` subcommands drive a daemon hosted as a Databricks App from outside
// the app (`--daemon-url https://<app>.databricksapps.com`). The Apps proxy
// only admits requests that carry a Databricks OAuth token, so every request to
// a Databricks Apps origin gets `Authorization: Bearer <token>` unless it
// already names its own Authorization. Requests to any other origin, including
// a local daemon, are left untouched, so the token never leaves for anywhere
// but Databricks.
//
// The token is `DATABRICKS_TOKEN` when set. Otherwise, given `DATABRICKS_HOST`
// or `DATABRICKS_CONFIG_PROFILE`, it is minted by the Databricks CLI
// (`databricks auth token`) from the user's `databricks auth login`, and minted
// again as it nears expiry — so a long-running `od mcp` started by a coding
// agent outlives any one token.

/** A fixed token, or a source asked for one before every request. */
export type DatabricksTokenSource = string | (() => Promise<string>);

export function isDatabricksAppsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /(^|\.)databricksapps\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function withDatabricksAppsBearer(fetchImpl: typeof fetch, token: DatabricksTokenSource): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!isDatabricksAppsUrl(url)) return fetchImpl(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('authorization')) {
      headers.set('authorization', `Bearer ${typeof token === 'string' ? token : await token()}`);
    }
    return fetchImpl(input, { ...init, headers });
  };
}

export interface DatabricksCliTarget {
  host?: string;
  profile?: string;
}

/** Runs the Databricks CLI with these args and resolves its stdout. */
export type DatabricksCliRunner = (args: string[]) => Promise<string>;

const runDatabricksCli: DatabricksCliRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('databricks', args, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).trim();
        reject(new Error(`\`databricks ${args.join(' ')}\` failed: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });

// Mint again this long before the token's own expiry.
const REFRESH_MARGIN_MS = 60_000;

/**
 * Tokens from `databricks auth token` for this workspace host or CLI profile
 * (the profile wins when both are given). A token is reused until it is within
 * a minute of expiry; concurrent requests share one CLI call.
 */
export function databricksCliTokenSource(
  target: DatabricksCliTarget,
  run: DatabricksCliRunner = runDatabricksCli,
  now: () => number = Date.now,
): () => Promise<string> {
  const args = ['auth', 'token', '--output', 'json'];
  if (target.profile) args.push('--profile', target.profile);
  else if (target.host) args.push('--host', target.host);
  let cached: { token: string; refreshAt: number } | null = null;
  let pending: Promise<string> | null = null;
  return () => {
    if (cached && now() < cached.refreshAt) return Promise.resolve(cached.token);
    pending ??= (async () => {
      try {
        const parsed = JSON.parse(await run(args)) as { access_token?: unknown; expiry?: unknown };
        if (typeof parsed.access_token !== 'string' || parsed.access_token === '') {
          throw new Error('`databricks auth token` returned no access_token');
        }
        const expiry = typeof parsed.expiry === 'string' ? Date.parse(parsed.expiry) : Number.NaN;
        // Without a readable expiry, mint again on the next request.
        cached = {
          token: parsed.access_token,
          refreshAt: Number.isFinite(expiry) ? expiry - REFRESH_MARGIN_MS : now(),
        };
        return parsed.access_token;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
}

export function installDatabricksAppsBearerAuth(env: NodeJS.ProcessEnv = process.env): void {
  const token = (env.DATABRICKS_TOKEN ?? '').trim();
  if (token !== '') {
    globalThis.fetch = withDatabricksAppsBearer(globalThis.fetch, token);
    return;
  }
  const profile = (env.DATABRICKS_CONFIG_PROFILE ?? '').trim();
  const host = (env.DATABRICKS_HOST ?? '').trim();
  if (profile === '' && host === '') return;
  globalThis.fetch = withDatabricksAppsBearer(
    globalThis.fetch,
    databricksCliTokenSource({ ...(profile ? { profile } : {}), ...(host ? { host } : {}) }),
  );
}
