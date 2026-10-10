// Request-scoped access to the signed-in Databricks user.
//
// The OBO middleware (`databricks-obo.ts`) resolves the caller once per
// request and binds it here two ways: on the Express request (for route
// handlers that hold `req`) and in an AsyncLocalStorage scope (for services
// deeper in the call graph that do not). Per-user data isolation builds on
// `requireCurrentUser()`; nothing scopes queries by owner yet.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';

export type CurrentUserSource =
  /** Resolved from `X-Forwarded-Access-Token` via SCIM `Me`. */
  | 'obo'
  /** `OD_LOCAL_DEV_USER`; only outside a Databricks App. */
  | 'local-dev';

export interface CurrentUser {
  /** Stable Databricks user id (SCIM `id`). Use this as the owner key. */
  id: string;
  /** SCIM `userName`; the user's email for human users. */
  userName: string;
  email: string | null;
  displayName: string | null;
  /** Group display names (SCIM `groups[].display`). */
  groups: string[];
  source: CurrentUserSource;
}

const CURRENT_USER = Symbol.for('open-design.currentUser');
const CURRENT_ACCESS_TOKEN = Symbol.for('open-design.currentUserAccessToken');

interface CurrentUserScope {
  user: CurrentUser;
  /**
   * The user's forwarded OBO token, kept only in memory for the request scope
   * so downstream Databricks calls (Model Serving) run as this user. Never
   * persisted or logged.
   */
  accessToken: string | null;
}

const storage = new AsyncLocalStorage<CurrentUserScope>();

type RequestWithUser = Request & {
  [CURRENT_USER]?: CurrentUser;
  [CURRENT_ACCESS_TOKEN]?: string | null;
};

/** Bind `user` (and its OBO token, when present) to `req` and run `fn` inside its async scope. */
export function runWithCurrentUser<T>(
  req: Request,
  user: CurrentUser,
  fn: () => T,
  accessToken: string | null = null,
): T {
  (req as RequestWithUser)[CURRENT_USER] = user;
  (req as RequestWithUser)[CURRENT_ACCESS_TOKEN] = accessToken;
  return storage.run({ user, accessToken }, fn);
}

/**
 * The current user for `req`, or for the active async scope when `req` is
 * omitted. `null` for requests the gate admitted without a user (open probes,
 * scoped preview assets, run-scoped agent tool calls).
 */
export function getCurrentUser(req?: Request): CurrentUser | null {
  if (req) return (req as RequestWithUser)[CURRENT_USER] ?? null;
  return storage.getStore()?.user ?? null;
}

/**
 * The current user's OBO access token for `req` or the active async scope.
 * `null` for local-dev users and requests admitted without a user.
 */
export function getCurrentUserAccessToken(req?: Request): string | null {
  if (req) return (req as RequestWithUser)[CURRENT_ACCESS_TOKEN] ?? null;
  return storage.getStore()?.accessToken ?? null;
}

export class CurrentUserMissingError extends Error {
  constructor() {
    super('No authenticated Databricks user in this request scope');
    this.name = 'CurrentUserMissingError';
  }
}

export function requireCurrentUser(req?: Request): CurrentUser {
  const user = getCurrentUser(req);
  if (!user) throw new CurrentUserMissingError();
  return user;
}
