import { describe, expect, it } from 'vitest';

import { databricksWorkspaceHost, resolveDaemonAuthMode } from '../src/databricks/auth-mode.js';
import {
  databricksCliTokenSource,
  isDatabricksAppsUrl,
  withDatabricksAppsBearer,
} from '../src/databricks/cli-bearer.js';
import { databricksFetch, DatabricksUserTokenRequiredError } from '../src/databricks/client.js';
import {
  cameThroughDatabricksAppsProxy,
  databricksAppOrigins,
  forwardedAccessToken,
} from '../src/databricks/forwarded-headers.js';
import {
  createDatabricksIdentityResolver,
  DatabricksIdentityError,
  scimMeIdentity,
} from '../src/databricks/identity.js';
import { externalAuthFlowForRequest } from '../src/databricks/middleware.js';
import { bindDatabricksRequestContext } from '../src/databricks/request-context.js';
import type { DatabricksRuntime } from '../src/databricks/runtime.js';
import { createServicePrincipalTokenSource } from '../src/databricks/service-principal.js';
import { isLocalSameOrigin } from '../src/origin-validation.js';

const HOST = 'https://example.cloud.databricks.com';
const DATABRICKS_ENV = { OD_AUTH_MODE: 'databricks' } as NodeJS.ProcessEnv;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function recordingFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('auth mode config', () => {
  it('resolves OD_AUTH_MODE and rejects unknown values', () => {
    expect(resolveDaemonAuthMode({} as NodeJS.ProcessEnv)).toBe('local');
    expect(resolveDaemonAuthMode({ OD_AUTH_MODE: ' Databricks ' } as NodeJS.ProcessEnv)).toBe('databricks');
    expect(() => resolveDaemonAuthMode({ OD_AUTH_MODE: 'okta' } as NodeJS.ProcessEnv)).toThrow(/OD_AUTH_MODE/);
  });

  it('normalizes DATABRICKS_HOST to an https origin', () => {
    expect(databricksWorkspaceHost({ DATABRICKS_HOST: 'example.cloud.databricks.com' } as NodeJS.ProcessEnv))
      .toBe(HOST);
    expect(databricksWorkspaceHost({ DATABRICKS_HOST: `${HOST}/` } as NodeJS.ProcessEnv)).toBe(HOST);
    expect(databricksWorkspaceHost({ DATABRICKS_HOST: 'http://127.0.0.1:9000' } as NodeJS.ProcessEnv))
      .toBe('http://127.0.0.1:9000');
    expect(() => databricksWorkspaceHost({ DATABRICKS_HOST: 'http://example.com' } as NodeJS.ProcessEnv))
      .toThrow(/https/);
    expect(databricksWorkspaceHost({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('forwarded headers', () => {
  it('reads the forwarded token and detects proxied requests', () => {
    expect(forwardedAccessToken({ headers: { 'x-forwarded-access-token': ' tok ' } })).toBe('tok');
    expect(forwardedAccessToken({ headers: {} })).toBeNull();
    expect(cameThroughDatabricksAppsProxy({ headers: { 'x-forwarded-host': 'a.databricksapps.com' } })).toBe(true);
    expect(cameThroughDatabricksAppsProxy({ headers: { 'x-request-id': 'abc' } })).toBe(false);
  });

  it('derives the app origin from X-Forwarded-Host only in Databricks auth mode', () => {
    const headers = { 'x-forwarded-host': 'app-1.aws.databricksapps.com' };
    expect(databricksAppOrigins(headers, DATABRICKS_ENV)).toEqual(['https://app-1.aws.databricksapps.com']);
    expect(databricksAppOrigins(headers, {} as NodeJS.ProcessEnv)).toEqual([]);
    expect(databricksAppOrigins({ 'x-forwarded-host': 'a.com, b.com' }, DATABRICKS_ENV)).toEqual([]);
    expect(databricksAppOrigins({ 'x-forwarded-host': 'a.com/evil' }, DATABRICKS_ENV)).toEqual([]);
  });

  it('treats the forwarded app origin as same-origin for isLocalSameOrigin', () => {
    const req = {
      headers: {
        host: '127.0.0.1:8000',
        origin: 'https://app-1.aws.databricksapps.com',
        'x-forwarded-host': 'app-1.aws.databricksapps.com',
      },
    };
    expect(isLocalSameOrigin(req, 8000, DATABRICKS_ENV)).toBe(true);
    expect(isLocalSameOrigin(req, 8000, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(isLocalSameOrigin({ headers: { ...req.headers, origin: 'https://evil.example' } }, 8000, DATABRICKS_ENV))
      .toBe(false);
  });
});

describe('SCIM identity resolver', () => {
  const scimMe = {
    id: '42',
    userName: 'ada@example.com',
    displayName: 'Ada',
    emails: [{ value: 'work@example.com', primary: false }, { value: 'ada@example.com', primary: true }],
    groups: [{ display: 'admins' }, { value: 'no-display' }],
  };

  it('maps SCIM Me to the session user', () => {
    expect(scimMeIdentity(scimMe)).toEqual({
      id: '42',
      userName: 'ada@example.com',
      displayName: 'Ada',
      email: 'ada@example.com',
      groups: ['admins'],
    });
    expect(scimMeIdentity({ id: 'sp-1', userName: 'a1b2-app-id' })).toMatchObject({ email: null, displayName: null });
    expect(scimMeIdentity({ userName: 'x' })).toBeNull();
  });

  it('caches by token, shares concurrent lookups, and expires after the TTL', async () => {
    let clock = 0;
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, scimMe));
    const resolver = createDatabricksIdentityResolver({ host: HOST, fetchImpl, ttlMs: 1_000, now: () => clock });

    const [a, b] = await Promise.all([resolver.resolve('t1'), resolver.resolve('t1')]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${HOST}/api/2.0/preview/scim/v2/Me`);
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer t1');

    await resolver.resolve('t2');
    expect(calls).toHaveLength(2);

    clock = 1_001;
    await resolver.resolve('t1');
    expect(calls).toHaveLength(3);
  });

  it('classifies failures and never caches them', async () => {
    let status = 401;
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(status, {}));
    const resolver = createDatabricksIdentityResolver({ host: HOST, fetchImpl });

    await expect(resolver.resolve('bad')).rejects.toMatchObject({ failure: 'rejected' });
    status = 403;
    await expect(resolver.resolve('bad')).rejects.toMatchObject({ failure: 'forbidden' });
    status = 500;
    await expect(resolver.resolve('bad')).rejects.toMatchObject({ failure: 'unavailable' });
    expect(calls).toHaveLength(3);

    const offline = createDatabricksIdentityResolver({
      host: HOST,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    const error = await offline.resolve('tok').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DatabricksIdentityError);
    expect((error as DatabricksIdentityError).failure).toBe('unavailable');
    expect((error as Error).message).not.toContain('tok');
  });
});

describe('service principal token source', () => {
  it('mints with client credentials and reuses the token until shortly before expiry', async () => {
    let clock = 0;
    let issued = 0;
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse(200, { access_token: `sp-${++issued}`, expires_in: 3600, token_type: 'Bearer' }),
    );
    const source = createServicePrincipalTokenSource({
      host: HOST,
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl,
      now: () => clock,
    });

    const [first, concurrent] = await Promise.all([source.getAccessToken(), source.getAccessToken()]);
    expect(first).toBe('sp-1');
    expect(concurrent).toBe('sp-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${HOST}/oidc/v1/token`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(new Headers(calls[0]!.init.headers).get('authorization'))
      .toBe(`Basic ${Buffer.from('client:secret').toString('base64')}`);
    expect(String(calls[0]!.init.body)).toBe('grant_type=client_credentials&scope=all-apis');

    clock = 3600_000 - 60_000 - 1;
    expect(await source.getAccessToken()).toBe('sp-1');
    clock = 3600_000 - 60_000;
    expect(await source.getAccessToken()).toBe('sp-2');
  });

  it('surfaces a failed mint and retries on the next call', async () => {
    let ok = false;
    const { fetchImpl } = recordingFetch(() =>
      ok ? jsonResponse(200, { access_token: 'sp', expires_in: 60 }) : jsonResponse(401, {}),
    );
    const source = createServicePrincipalTokenSource({ host: HOST, clientId: 'c', clientSecret: 's', fetchImpl });
    await expect(source.getAccessToken()).rejects.toThrow(/HTTP 401/);
    ok = true;
    expect(await source.getAccessToken()).toBe('sp');
  });
});

describe('databricksFetch', () => {
  const user = { id: '1', userName: 'ada@example.com', displayName: null, email: null, groups: [] };

  function runtimeWithSp(): DatabricksRuntime {
    return {
      host: HOST,
      identity: { resolve: async () => user },
      servicePrincipal: { clientId: 'c', getAccessToken: async () => 'sp-token' },
    };
  }

  it('acts as the signed-in user with the request\'s on-behalf-of token', async () => {
    const req = {};
    bindDatabricksRequestContext(req, { user, accessToken: 'obo-token' });
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {}));
    await databricksFetch(runtimeWithSp(), { as: 'user', req }, '/api/2.0/serving-endpoints', {}, fetchImpl);
    expect(calls[0]!.url).toBe(`${HOST}/api/2.0/serving-endpoints`);
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer obo-token');
  });

  it('fails closed for a user call without a user token instead of using the service principal', async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {}));
    await expect(databricksFetch(runtimeWithSp(), { as: 'user', req: {} }, '/api/x', {}, fetchImpl))
      .rejects.toBeInstanceOf(DatabricksUserTokenRequiredError);
    expect(calls).toHaveLength(0);
  });

  it('acts as the app service principal only when asked to', async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {}));
    await databricksFetch(runtimeWithSp(), { as: 'app' }, '/api/x', {}, fetchImpl);
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer sp-token');

    await expect(
      databricksFetch({ ...runtimeWithSp(), servicePrincipal: null }, { as: 'app' }, '/api/x', {}, fetchImpl),
    ).rejects.toThrow(/service principal is not configured/);
  });
});

describe('CLI Databricks Apps bearer', () => {
  it('adds the token only for Databricks Apps origins and keeps an explicit Authorization', async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {}));
    const wrapped = withDatabricksAppsBearer(fetchImpl, 'user-token');

    await wrapped('https://app-1.aws.databricksapps.com/api/auth/session');
    await wrapped('http://127.0.0.1:7456/api/auth/session');
    await wrapped('https://app-1.aws.databricksapps.com/api/x', { headers: { authorization: 'Bearer other' } });
    await wrapped('https://databricksapps.com.evil.example/api/x');

    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer user-token');
    expect(new Headers(calls[1]!.init?.headers).get('authorization')).toBeNull();
    expect(new Headers(calls[2]!.init.headers).get('authorization')).toBe('Bearer other');
    expect(new Headers(calls[3]!.init?.headers).get('authorization')).toBeNull();
    expect(isDatabricksAppsUrl('http://app-1.aws.databricksapps.com/')).toBe(false);
  });

  it('mints tokens from the Databricks CLI and mints again only near expiry', async () => {
    let clock = Date.parse('2026-10-14T00:00:00Z');
    const runs: string[][] = [];
    const source = databricksCliTokenSource({ host: HOST }, async (args) => {
      runs.push(args);
      return JSON.stringify({
        access_token: `token-${runs.length}`,
        token_type: 'Bearer',
        expiry: new Date(clock + 3_600_000).toISOString(),
      });
    }, () => clock);

    const [first, concurrent] = await Promise.all([source(), source()]);
    expect([first, concurrent]).toEqual(['token-1', 'token-1']);
    expect(runs).toEqual([['auth', 'token', '--output', 'json', '--host', HOST]]);

    clock += 3_600_000 - 30_000; // inside the last minute of the token's life
    expect(await source()).toBe('token-2');
    expect(runs).toHaveLength(2);
  });

  it('prefers a CLI profile and asks the source only for Databricks Apps requests', async () => {
    const runs: string[][] = [];
    const source = databricksCliTokenSource({ host: HOST, profile: 'au' }, async (args) => {
      runs.push(args);
      return JSON.stringify({ access_token: 'minted', expiry: '2099-01-01T00:00:00Z' });
    });
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {}));
    const wrapped = withDatabricksAppsBearer(fetchImpl, source);

    await wrapped('http://127.0.0.1:7456/api/health');
    expect(runs).toHaveLength(0);
    await wrapped('https://app-1.aws.databricksapps.com/api/projects');
    expect(new Headers(calls[1]!.init.headers).get('authorization')).toBe('Bearer minted');
    expect(runs).toEqual([['auth', 'token', '--output', 'json', '--profile', 'au']]);
  });

  it('surfaces a CLI that returns no token', async () => {
    const source = databricksCliTokenSource({ host: HOST }, async () => '{}');
    await expect(source()).rejects.toThrow('returned no access_token');
  });
});

describe('external sign-in entry points', () => {
  it('matches every external login / OAuth entry point, case- and slash-tolerant', () => {
    expect(externalAuthFlowForRequest('POST', '/api/integrations/vela/login')).toBe('OpenDesign Cloud sign-in');
    expect(externalAuthFlowForRequest('post', '/API/Integrations/Vela/Login/')).toBe('OpenDesign Cloud sign-in');
    expect(externalAuthFlowForRequest('POST', '/api/xai/oauth/start')).toBe('xAI OAuth');
    expect(externalAuthFlowForRequest('POST', '/api/xai/oauth/complete')).toBe('xAI OAuth');
    expect(externalAuthFlowForRequest('POST', '/api/mcp/oauth/start')).toBe('MCP server OAuth');
    expect(externalAuthFlowForRequest('GET', '/api/mcp/oauth/callback')).toBe('MCP server OAuth');
    expect(externalAuthFlowForRequest('POST', '/api/connectors/github/connect')).toBe('connector OAuth');
    expect(externalAuthFlowForRequest('GET', '/api/connectors/oauth/callback/github')).toBe('connector OAuth');
    expect(externalAuthFlowForRequest('POST', '/api/agents/antigravity/oauth-launch')).toBe('agent CLI sign-in');
  });

  it('leaves status, disconnect, and unrelated routes alone', () => {
    expect(externalAuthFlowForRequest('GET', '/api/integrations/vela/status')).toBeNull();
    expect(externalAuthFlowForRequest('POST', '/api/xai/oauth/disconnect')).toBeNull();
    expect(externalAuthFlowForRequest('GET', '/api/mcp/oauth/status')).toBeNull();
    expect(externalAuthFlowForRequest('GET', '/api/integrations/vela/login')).toBeNull();
    expect(externalAuthFlowForRequest('GET', '/api/projects')).toBeNull();
  });
});
