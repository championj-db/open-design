import type { AuthSessionProvider } from '@open-design/contracts';

// `OD_AUTH_MODE` selects who authenticates API callers.
//
// - unset / `local`: the daemon's own model — loopback callers are trusted and
//   `OD_API_TOKEN` (or `OD_DISABLE_API_AUTH` behind a trusted proxy) governs
//   everything else.
// - `databricks`: the daemon runs as a Databricks App. The Apps proxy signs
//   every user in and forwards an on-behalf-of token per request; the daemon
//   verifies it (see `databricks/middleware.ts`). This mode replaces
//   `OD_API_TOKEN` / `OD_DISABLE_API_AUTH` and disables every external sign-in
//   flow.
export type DaemonAuthMode = AuthSessionProvider;

export function resolveDaemonAuthMode(env: NodeJS.ProcessEnv = process.env): DaemonAuthMode {
  const raw = (env.OD_AUTH_MODE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'local') return 'local';
  if (raw === 'databricks') return 'databricks';
  throw new Error(`OD_AUTH_MODE must be "databricks" or "local" (or unset), got: ${env.OD_AUTH_MODE}`);
}

/** Non-throwing check for call sites that only branch on the mode; startup validates it. */
export function isDatabricksAuthMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OD_AUTH_MODE ?? '').trim().toLowerCase() === 'databricks';
}

/**
 * The workspace URL from `DATABRICKS_HOST` (injected by Databricks Apps), as a
 * bare origin. A value without a scheme is treated as https. Plain http is
 * accepted only for loopback hosts so tests can point at a local stub.
 */
export function databricksWorkspaceHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.DATABRICKS_HOST ?? '').trim();
  if (raw === '') return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`DATABRICKS_HOST is not a valid URL: ${raw}`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`DATABRICKS_HOST must be an https URL, got: ${raw}`);
  }
  return url.origin;
}
