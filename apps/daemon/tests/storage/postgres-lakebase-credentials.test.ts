import { describe, expect, it, vi } from 'vitest';
import {
  createLakebasePasswordProvider,
  normalizeWorkspaceHost,
  type LakebaseCredentialConfig,
} from '../../src/storage/postgres/lakebase-credentials.js';

const base: LakebaseCredentialConfig = {
  source: 'rest',
  endpoint: 'projects/p/branches/main/endpoints/ep',
  workspaceHost: 'adb-1.azuredatabricks.net',
  workspaceToken: null,
  clientId: 'sp-id',
  clientSecret: 'sp-secret',
  cliPath: 'databricks',
  cliProfile: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Lakebase password provider', () => {
  it('normalizes workspace hosts', () => {
    expect(normalizeWorkspaceHost('adb-1.net/')).toBe('https://adb-1.net');
    expect(normalizeWorkspaceHost('https://adb-1.net')).toBe('https://adb-1.net');
  });

  it('mints via OIDC client credentials then the postgres credentials API, and caches', async () => {
    let now = Date.parse('2026-10-10T00:00:00Z');
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/oidc/v1/token')) {
        expect(init?.headers).toMatchObject({
          authorization: `Basic ${Buffer.from('sp-id:sp-secret').toString('base64')}`,
        });
        expect(init?.body).toBe('grant_type=client_credentials&scope=all-apis');
        return jsonResponse({ access_token: 'workspace-token' });
      }
      expect(href).toBe('https://adb-1.azuredatabricks.net/api/2.0/postgres/credentials');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer workspace-token' });
      expect(JSON.parse(String(init?.body))).toEqual({ endpoint: base.endpoint });
      return jsonResponse({ token: `db-token-${fetchImpl.mock.calls.length}`, expire_time: '2026-10-10T01:00:00Z' });
    });
    const password = createLakebasePasswordProvider(base, { fetch: fetchImpl as typeof fetch, now: () => now });

    await expect(password()).resolves.toBe('db-token-2');
    await expect(password()).resolves.toBe('db-token-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Within five minutes of expiry the provider mints a fresh credential.
    now = Date.parse('2026-10-10T00:56:00Z');
    await expect(password()).resolves.toBe('db-token-4');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('shares one in-flight mint between concurrent connections', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ token: 'shared' }));
    const password = createLakebasePasswordProvider(
      { ...base, workspaceToken: 'pat' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    await expect(Promise.all([password(), password(), password()])).resolves.toEqual(['shared', 'shared', 'shared']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces HTTP failures without leaking the response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, 403));
    const password = createLakebasePasswordProvider(
      { ...base, workspaceToken: 'pat' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    await expect(password()).rejects.toThrow('Lakebase credential request failed: HTTP 403');
  });

  it('mints through the Databricks CLI when configured', async () => {
    const runCli = vi.fn(async () => JSON.stringify({ token: 'cli-token', expire_time: '2099-01-01T00:00:00Z' }));
    const password = createLakebasePasswordProvider(
      { ...base, source: 'cli', cliProfile: 'dev' },
      { runCli },
    );
    await expect(password()).resolves.toBe('cli-token');
    expect(runCli).toHaveBeenCalledWith('databricks', [
      'postgres', 'generate-database-credential', base.endpoint, '-o', 'json', '--profile', 'dev',
    ]);
  });
});
