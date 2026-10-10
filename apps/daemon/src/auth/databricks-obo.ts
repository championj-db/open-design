// Databricks Apps on-behalf-of (OBO) request authentication.
//
// The Apps proxy signs the user in and forwards a short-lived user OAuth token
// in `X-Forwarded-Access-Token`. That token is the only credential this gate
// trusts: it is exchanged for an identity through SCIM `Me` and the result is
// cached per token for a short TTL. `X-Forwarded-Email` / `-User` /
// `-Preferred-Username` are display hints the proxy also sets; they are never
// used for authorization.
//
// The gate fails closed: no token (and no explicit local-dev user) is a 401.
// The token is never logged or persisted; the identity cache keys on its hash,
// and the request scope holds it in memory so Model Serving calls can run on
// behalf of the user (`getCurrentUserAccessToken`).
import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { sendApiError } from '../http/api-errors.js';
import { runWithCurrentUser, type CurrentUser } from './current-user.js';

export const FORWARDED_ACCESS_TOKEN_HEADER = 'x-forwarded-access-token';
export const LOCAL_DEV_USER_ENV = 'OD_LOCAL_DEV_USER';
export const DEFAULT_IDENTITY_CACHE_TTL_MS = 60_000;
const MAX_IDENTITY_CACHE_ENTRIES = 1_000;
const SCIM_ME_PATH = '/api/2.0/preview/scim/v2/Me';
const SCIM_TIMEOUT_MS = 10_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<globalThis.Response>;

export class DatabricksIdentityError extends Error {
  constructor(
    readonly status: 401 | 500 | 503,
    readonly code: 'UNAUTHORIZED' | 'UPSTREAM_UNAVAILABLE' | 'INTERNAL_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'DatabricksIdentityError';
  }
}

/** True when the process runs as a deployed Databricks App. */
export function isDatabricksAppRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DATABRICKS_APP_NAME?.trim() || env.DATABRICKS_APP_PORT?.trim());
}

/** `DATABRICKS_HOST` as an origin (`https://` assumed when no scheme). */
export function databricksHostOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.DATABRICKS_HOST?.trim();
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    return null;
  }
}

/**
 * The local-dev identity from `OD_LOCAL_DEV_USER`, or null when unset.
 * Throws when it is set inside a deployed Databricks App: there it would turn
 * every unauthenticated request into that user, so startup refuses instead.
 */
export function localDevUserFromEnv(env: NodeJS.ProcessEnv = process.env): CurrentUser | null {
  const email = env[LOCAL_DEV_USER_ENV]?.trim();
  if (!email) return null;
  if (isDatabricksAppRuntime(env)) {
    throw new Error(
      `${LOCAL_DEV_USER_ENV} is a local-development bypass and must not be set in a Databricks App ` +
        '(DATABRICKS_APP_NAME / DATABRICKS_APP_PORT are present). Remove it; the app authenticates ' +
        'users through X-Forwarded-Access-Token.',
    );
  }
  return {
    id: `local-dev:${email.toLowerCase()}`,
    userName: email,
    email,
    displayName: email,
    groups: [],
    source: 'local-dev',
  };
}

interface ScimMeResponse {
  id?: unknown;
  userName?: unknown;
  displayName?: unknown;
  emails?: Array<{ value?: unknown; primary?: unknown }>;
  groups?: Array<{ display?: unknown; value?: unknown }>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function currentUserFromScimMe(body: ScimMeResponse): CurrentUser {
  const id = nonEmptyString(body.id);
  const userName = nonEmptyString(body.userName);
  if (!id || !userName) {
    throw new DatabricksIdentityError(503, 'UPSTREAM_UNAVAILABLE', 'SCIM Me response is missing id or userName');
  }
  const emails = Array.isArray(body.emails) ? body.emails : [];
  const email =
    nonEmptyString(emails.find((entry) => entry?.primary === true)?.value) ??
    nonEmptyString(emails[0]?.value) ??
    (userName.includes('@') ? userName : null);
  const groups = (Array.isArray(body.groups) ? body.groups : [])
    .map((group) => nonEmptyString(group?.display) ?? nonEmptyString(group?.value))
    .filter((group): group is string => group !== null);
  return {
    id,
    userName,
    email,
    displayName: nonEmptyString(body.displayName),
    groups,
    source: 'obo',
  };
}

export interface DatabricksIdentityResolverOptions {
  /** Workspace origin, e.g. `https://dbc-123.cloud.databricks.com`. */
  hostOrigin: string | null;
  fetch?: FetchLike;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface DatabricksIdentityResolver {
  resolve(accessToken: string): Promise<CurrentUser>;
  clear(): void;
}

export function createDatabricksIdentityResolver(
  options: DatabricksIdentityResolverOptions,
): DatabricksIdentityResolver {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const ttlMs = options.cacheTtlMs ?? DEFAULT_IDENTITY_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  // Keyed by a hash so the cache never holds the token itself.
  const cache = new Map<string, { user: CurrentUser; expiresAtMs: number }>();
  const inflight = new Map<string, Promise<CurrentUser>>();

  async function lookup(accessToken: string): Promise<CurrentUser> {
    if (!options.hostOrigin) {
      throw new DatabricksIdentityError(
        500,
        'INTERNAL_ERROR',
        'DATABRICKS_HOST is not set; cannot resolve the forwarded user identity',
      );
    }
    let response: globalThis.Response;
    try {
      response = await fetchImpl(`${options.hostOrigin}${SCIM_ME_PATH}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/scim+json, application/json' },
        signal: AbortSignal.timeout(SCIM_TIMEOUT_MS),
      });
    } catch {
      throw new DatabricksIdentityError(503, 'UPSTREAM_UNAVAILABLE', 'Databricks identity lookup failed');
    }
    if (response.status === 401 || response.status === 403) {
      throw new DatabricksIdentityError(401, 'UNAUTHORIZED', 'Forwarded Databricks access token was rejected');
    }
    if (!response.ok) {
      throw new DatabricksIdentityError(
        503,
        'UPSTREAM_UNAVAILABLE',
        `Databricks identity lookup returned HTTP ${response.status}`,
      );
    }
    let body: ScimMeResponse;
    try {
      body = (await response.json()) as ScimMeResponse;
    } catch {
      throw new DatabricksIdentityError(503, 'UPSTREAM_UNAVAILABLE', 'SCIM Me response was not JSON');
    }
    return currentUserFromScimMe(body ?? {});
  }

  return {
    async resolve(accessToken) {
      const key = createHash('sha256').update(accessToken).digest('hex');
      const cached = cache.get(key);
      if (cached && cached.expiresAtMs > now()) return cached.user;
      if (cached) cache.delete(key);

      const pending = inflight.get(key);
      if (pending) return pending;
      const request = lookup(accessToken)
        .then((user) => {
          if (cache.size >= MAX_IDENTITY_CACHE_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          cache.set(key, { user, expiresAtMs: now() + ttlMs });
          return user;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, request);
      return request;
    },
    clear() {
      cache.clear();
      inflight.clear();
    },
  };
}

export function forwardedAccessToken(req: Request): string | null {
  const value = req.headers[FORWARDED_ACCESS_TOKEN_HEADER];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export interface DatabricksAuthMiddlewareOptions {
  resolver: DatabricksIdentityResolver;
  /** From `localDevUserFromEnv()`; null in a deployed app. */
  localDevUser: CurrentUser | null;
  /**
   * Requests admitted without a user (health probes, scoped preview assets,
   * run-scoped agent tool tokens). Their routes do their own authorization.
   */
  admitWithoutUser?: (req: Request) => boolean;
}

export function createDatabricksAuthMiddleware(options: DatabricksAuthMiddlewareOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = forwardedAccessToken(req);
    if (!token) {
      if (options.localDevUser) return runWithCurrentUser(req, options.localDevUser, next);
      if (options.admitWithoutUser?.(req)) return next();
      return sendApiError(
        res,
        401,
        'UNAUTHORIZED',
        'Databricks user authorization required (missing X-Forwarded-Access-Token)',
      );
    }
    options.resolver.resolve(token).then(
      (user) => runWithCurrentUser(req, user, next, token),
      (error: unknown) => {
        if (error instanceof DatabricksIdentityError) {
          if (error.status !== 401) console.warn(`[auth] ${error.code}: ${error.message}`);
          return sendApiError(res, error.status, error.code, error.message);
        }
        console.warn('[auth] identity resolution failed', (error as Error)?.message ?? error);
        return sendApiError(res, 503, 'UPSTREAM_UNAVAILABLE', 'Databricks identity lookup failed');
      },
    );
  };
}
