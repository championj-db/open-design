import { databricksRequestContext } from './request-context.js';
import type { DatabricksRuntime } from './runtime.js';
import { DatabricksServicePrincipalError } from './service-principal.js';

// The one way daemon code calls a Databricks REST API. Every call names whose
// identity it acts under:
//
// - `{ as: 'user', req }`: the on-behalf-of token of the user behind `req`, so
//   Unity Catalog and workspace ACLs apply that user's permissions. Use this
//   for anything a user asked for (data, AI, files).
// - `{ as: 'app' }`: the app's service principal, for app-owned infrastructure
//   that no user request is driving.
//
// A user call without a verified user token fails closed with
// `DatabricksUserTokenRequiredError`; it is never retried as the service
// principal, which would silently widen the user's access to the app's.
export type DatabricksCaller = { as: 'user'; req: object } | { as: 'app' };

export class DatabricksUserTokenRequiredError extends Error {
  constructor() {
    super('This Databricks call needs the signed-in user\'s on-behalf-of token, and the request carries none');
    this.name = 'DatabricksUserTokenRequiredError';
  }
}

export async function databricksFetch(
  runtime: DatabricksRuntime,
  caller: DatabricksCaller,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!path.startsWith('/')) throw new Error(`databricksFetch path must start with "/": ${path}`);
  const token = await callerAccessToken(runtime, caller);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return fetchImpl(`${runtime.host}${path}`, { ...init, headers });
}

async function callerAccessToken(runtime: DatabricksRuntime, caller: DatabricksCaller): Promise<string> {
  if (caller.as === 'user') {
    const context = databricksRequestContext(caller.req);
    if (!context) throw new DatabricksUserTokenRequiredError();
    return context.accessToken;
  }
  if (!runtime.servicePrincipal) {
    throw new DatabricksServicePrincipalError(
      'The app service principal is not configured (DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET are unset)',
    );
  }
  return runtime.servicePrincipal.getAccessToken();
}
