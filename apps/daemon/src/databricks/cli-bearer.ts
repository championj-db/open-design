// Lets `od` subcommands drive a daemon hosted as a Databricks App from outside
// the app (`--daemon-url https://<app>.databricksapps.com`). The Apps proxy
// only admits requests that carry a Databricks OAuth token, so when
// `DATABRICKS_TOKEN` is set every request to a Databricks Apps origin gets
// `Authorization: Bearer <token>` unless it already names its own
// Authorization. Requests to any other origin, including a local daemon, are
// left untouched, so the token never leaves for anywhere but Databricks.

export function isDatabricksAppsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /(^|\.)databricksapps\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function withDatabricksAppsBearer(fetchImpl: typeof fetch, token: string): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!isDatabricksAppsUrl(url)) return fetchImpl(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers });
  };
}

export function installDatabricksAppsBearerAuth(env: NodeJS.ProcessEnv = process.env): void {
  const token = (env.DATABRICKS_TOKEN ?? '').trim();
  if (token === '') return;
  globalThis.fetch = withDatabricksAppsBearer(globalThis.fetch, token);
}
