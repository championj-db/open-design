import { createHash } from 'node:crypto';
import type { AuthSessionUser } from '@open-design/contracts';

// Resolves a forwarded on-behalf-of token to a verified identity through SCIM
// `Me`. The `X-Forwarded-Email` / `-User` headers are display hints only; this
// lookup is what makes an identity trustworthy, and it doubles as validation
// of the token itself (an invalid or expired token is rejected here).
//
// Results are cached in memory for a short TTL, keyed by a SHA-256 digest of
// the token, so a page load that fans out into dozens of API calls costs one
// SCIM round trip. Concurrent lookups for the same token share one request.
// Neither the token nor the cache is ever written to disk or logs.

export type DatabricksIdentityFailure = 'rejected' | 'forbidden' | 'unavailable';

export class DatabricksIdentityError extends Error {
  constructor(
    readonly failure: DatabricksIdentityFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DatabricksIdentityError';
  }
}

export interface DatabricksIdentityResolver {
  resolve(accessToken: string): Promise<AuthSessionUser>;
}

export interface DatabricksIdentityResolverOptions {
  /** Workspace origin, e.g. `https://<workspace>.cloud.databricks.com`. */
  host: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  maxEntries?: number;
  timeoutMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export function createDatabricksIdentityResolver({
  host,
  fetchImpl = fetch,
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
}: DatabricksIdentityResolverOptions): DatabricksIdentityResolver {
  const cache = new Map<string, { expiresAt: number; identity: Promise<AuthSessionUser> }>();
  return {
    resolve(accessToken) {
      const key = createHash('sha256').update(accessToken).digest('hex');
      const at = now();
      const cached = cache.get(key);
      if (cached && cached.expiresAt > at) return cached.identity;
      cache.delete(key);
      const identity = fetchScimMe(host, accessToken, fetchImpl, timeoutMs);
      cache.set(key, { expiresAt: at + ttlMs, identity });
      // A failed lookup must not be served from cache to the next request.
      identity.catch(() => {
        if (cache.get(key)?.identity === identity) cache.delete(key);
      });
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return identity;
    },
  };
}

async function fetchScimMe(
  host: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<AuthSessionUser> {
  let response: Response;
  try {
    response = await fetchImpl(`${host}/api/2.0/preview/scim/v2/Me`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/scim+json, application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new DatabricksIdentityError(
      'unavailable',
      `SCIM Me request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 401) {
    throw new DatabricksIdentityError('rejected', 'SCIM Me rejected the forwarded Databricks token');
  }
  if (response.status === 403) {
    throw new DatabricksIdentityError(
      'forbidden',
      'The forwarded Databricks token may not read SCIM Me; grant the app the iam.current-user:read user API scope',
    );
  }
  if (!response.ok) {
    throw new DatabricksIdentityError('unavailable', `SCIM Me returned HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DatabricksIdentityError('unavailable', 'SCIM Me returned a non-JSON body');
  }
  const identity = scimMeIdentity(body);
  if (!identity) throw new DatabricksIdentityError('unavailable', 'SCIM Me response has no user id');
  return identity;
}

export function scimMeIdentity(body: unknown): AuthSessionUser | null {
  if (!isRecord(body)) return null;
  const id = nonEmptyString(body.id);
  if (!id) return null;
  const userName = nonEmptyString(body.userName) ?? id;
  const emails = Array.isArray(body.emails) ? body.emails.filter(isRecord) : [];
  const primaryEmail = emails.find((entry) => entry.primary === true) ?? emails[0];
  const groups = Array.isArray(body.groups)
    ? body.groups
        .filter(isRecord)
        .map((group) => nonEmptyString(group.display))
        .filter((name): name is string => name !== null)
    : [];
  return {
    id,
    userName,
    displayName: nonEmptyString(body.displayName),
    email: nonEmptyString(primaryEmail?.value) ?? (userName.includes('@') ? userName : null),
    groups,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
