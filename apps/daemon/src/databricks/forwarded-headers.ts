import { isDatabricksAuthMode } from './auth-mode.js';

// Headers the Databricks Apps proxy sets on every request it forwards. The
// proxy reaches the app over the container's local network (often loopback),
// so the peer address alone cannot tell a proxied browser request from an
// in-container caller such as an agent tool; these headers can.
export const FORWARDED_ACCESS_TOKEN_HEADER = 'x-forwarded-access-token';
const DATABRICKS_PROXY_HEADERS = [
  FORWARDED_ACCESS_TOKEN_HEADER,
  'x-forwarded-host',
  'x-forwarded-email',
  'x-forwarded-user',
  'x-forwarded-preferred-username',
  'x-real-ip',
] as const;

type HeaderBag = { readonly [name: string]: unknown };

function singleHeader(headers: HeaderBag | undefined, name: string): string | null {
  const value = headers?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof first === 'string' ? first.trim() : '';
  return trimmed === '' ? null : trimmed;
}

/** The on-behalf-of user token for this request. Never log or persist it. */
export function forwardedAccessToken(req: { headers?: HeaderBag }): string | null {
  return singleHeader(req.headers, FORWARDED_ACCESS_TOKEN_HEADER);
}

export function cameThroughDatabricksAppsProxy(req: { headers?: HeaderBag }): boolean {
  return DATABRICKS_PROXY_HEADERS.some((name) => singleHeader(req.headers, name) !== null);
}

/**
 * The browser-visible origin of the app (`https://<X-Forwarded-Host>`) when the
 * daemon runs in Databricks auth mode, else an empty list. The proxy rewrites
 * `Host` to its upstream address, so this is the only header that names the
 * origin a same-origin browser request carries. Only a bare host[:port] is
 * accepted; anything else (a list, a path) is ignored rather than trusted.
 */
export function databricksAppOrigins(
  headers: HeaderBag | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isDatabricksAuthMode(env)) return [];
  const forwardedHost = singleHeader(headers, 'x-forwarded-host');
  if (!forwardedHost || !/^[a-z0-9.-]+(:\d+)?$/i.test(forwardedHost)) return [];
  return [new URL(`https://${forwardedHost}`).origin];
}
