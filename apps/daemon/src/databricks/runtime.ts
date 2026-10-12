import { databricksWorkspaceHost } from './auth-mode.js';
import { createDatabricksIdentityResolver, type DatabricksIdentityResolver } from './identity.js';
import { servicePrincipalFromEnv, type ServicePrincipalTokenSource } from './service-principal.js';

// Everything the daemon needs to act against the Databricks workspace it is
// deployed in, built once at startup when `OD_AUTH_MODE=databricks`.
export interface DatabricksRuntime {
  /** Workspace origin, from `DATABRICKS_HOST`. */
  host: string;
  /** Verifies forwarded on-behalf-of tokens (user identity). */
  identity: DatabricksIdentityResolver;
  /** The app's service principal, or null when its credentials are not injected. */
  servicePrincipal: ServicePrincipalTokenSource | null;
}

export function createDatabricksRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): DatabricksRuntime {
  const host = databricksWorkspaceHost(env);
  if (!host) {
    throw new Error(
      'OD_AUTH_MODE=databricks requires DATABRICKS_HOST (Databricks Apps sets it automatically).',
    );
  }
  return {
    host,
    identity: createDatabricksIdentityResolver({ host, fetchImpl }),
    servicePrincipal: servicePrincipalFromEnv(host, env, fetchImpl),
  };
}
