import type { AuthSessionUser } from '@open-design/contracts';

// The verified caller of one HTTP request in Databricks auth mode. Bound to
// the request object by the auth middleware and released with it: the token
// is read fresh from each request and lives only as long as that request.
export interface DatabricksRequestContext {
  user: AuthSessionUser;
  /** The on-behalf-of token. Pass it only to Databricks APIs; never log or persist it. */
  accessToken: string;
}

const contexts = new WeakMap<object, DatabricksRequestContext>();

export function bindDatabricksRequestContext(req: object, context: DatabricksRequestContext): void {
  contexts.set(req, context);
}

/** Null for local auth mode and for in-container callers that never passed the Apps proxy. */
export function databricksRequestContext(req: object): DatabricksRequestContext | null {
  return contexts.get(req) ?? null;
}
