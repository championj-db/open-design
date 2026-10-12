// The app's own Databricks identity: the service principal Databricks Apps
// creates for every app and injects as `DATABRICKS_CLIENT_ID` /
// `DATABRICKS_CLIENT_SECRET`. Tokens come from the workspace OAuth M2M
// endpoint (client-credentials grant) and are cached until shortly before
// they expire.
//
// This identity is for app-owned infrastructure only (work no user request is
// driving). User-facing calls must use the caller's on-behalf-of token so
// Unity Catalog enforces that user's permissions; `databricks/client.ts`
// refuses to substitute one for the other.

export class DatabricksServicePrincipalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabricksServicePrincipalError';
  }
}

export interface ServicePrincipalTokenSource {
  readonly clientId: string;
  getAccessToken(): Promise<string>;
}

export interface ServicePrincipalTokenSourceOptions {
  host: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Refresh this long before the token's stated expiry. */
  refreshSkewMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REFRESH_SKEW_MS = 60_000;

export function createServicePrincipalTokenSource({
  host,
  clientId,
  clientSecret,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
}: ServicePrincipalTokenSourceOptions): ServicePrincipalTokenSource {
  let cached: { accessToken: string; refreshAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    let response: Response;
    try {
      response = await fetchImpl(`${host}/oidc/v1/token`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all-apis' }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DatabricksServicePrincipalError(
        `Service principal token request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new DatabricksServicePrincipalError(
        `Service principal token request returned HTTP ${response.status}`,
      );
    }
    const body = (await response.json().catch(() => null)) as
      | { access_token?: unknown; expires_in?: unknown }
      | null;
    const accessToken = typeof body?.access_token === 'string' ? body.access_token : '';
    const expiresInSeconds = typeof body?.expires_in === 'number' ? body.expires_in : 0;
    if (accessToken === '' || expiresInSeconds <= 0) {
      throw new DatabricksServicePrincipalError('Service principal token response is missing access_token or expires_in');
    }
    cached = { accessToken, refreshAt: now() + expiresInSeconds * 1000 - refreshSkewMs };
    return accessToken;
  }

  return {
    clientId,
    getAccessToken() {
      if (cached && cached.refreshAt > now()) return Promise.resolve(cached.accessToken);
      inFlight ??= mint().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

export function servicePrincipalFromEnv(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): ServicePrincipalTokenSource | null {
  const clientId = (env.DATABRICKS_CLIENT_ID ?? '').trim();
  const clientSecret = (env.DATABRICKS_CLIENT_SECRET ?? '').trim();
  if (clientId === '' || clientSecret === '') return null;
  return createServicePrincipalTokenSource({ host, clientId, clientSecret, fetchImpl });
}
