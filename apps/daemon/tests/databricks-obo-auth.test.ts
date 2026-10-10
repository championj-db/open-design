// Databricks OBO request authentication (docs/databricks-native/INTEGRATION_REFERENCE.md §2).
//
// Unit coverage for the SCIM-backed identity resolver and the express gate,
// plus an end-to-end pass through startServer() against a local stand-in for
// the workspace SCIM `Me` endpoint.

import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabricksAuthMiddleware,
  createDatabricksIdentityResolver,
  databricksHostOrigin,
  localDevUserFromEnv,
  type FetchLike,
} from '../src/auth/databricks-obo.js';
import { getCurrentUser, requireCurrentUser } from '../src/auth/current-user.js';
import { isDatabricksAppSameOrigin } from '../src/origin-validation.js';
import { startServer } from '../src/server.js';

const SCIM_ME = {
  id: '4242',
  userName: 'ada@example.com',
  displayName: 'Ada Lovelace',
  emails: [{ value: 'ada@example.com', primary: true }],
  groups: [{ display: 'users', value: '1' }, { display: 'designers', value: '2' }],
};
const VALID_TOKEN = 'dapi-valid-user-token';

function scimFetch(): ReturnType<typeof vi.fn<FetchLike>> {
  return vi.fn<FetchLike>(async (_url, init) => {
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Bearer ${VALID_TOKEN}`) return new Response('{}', { status: 401 });
    return Response.json(SCIM_ME);
  });
}

async function listen(app: express.Express): Promise<{ url: string; server: Server }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('createDatabricksIdentityResolver', () => {
  it('resolves the SCIM Me identity and caches it per token', async () => {
    const fetchImpl = scimFetch();
    let now = 1_000;
    const resolver = createDatabricksIdentityResolver({
      hostOrigin: 'https://dbc.example.com',
      fetch: fetchImpl,
      cacheTtlMs: 60_000,
      now: () => now,
    });

    const user = await resolver.resolve(VALID_TOKEN);
    expect(user).toEqual({
      id: '4242',
      userName: 'ada@example.com',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      groups: ['users', 'designers'],
      source: 'obo',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://dbc.example.com/api/2.0/preview/scim/v2/Me',
      expect.objectContaining({ method: 'GET' }),
    );

    await resolver.resolve(VALID_TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 60_001;
    await resolver.resolve(VALID_TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a token SCIM refuses with a 401 identity error', async () => {
    const resolver = createDatabricksIdentityResolver({
      hostOrigin: 'https://dbc.example.com',
      fetch: scimFetch(),
    });
    await expect(resolver.resolve('forged')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('fails closed when DATABRICKS_HOST is not configured', async () => {
    const resolver = createDatabricksIdentityResolver({ hostOrigin: null, fetch: scimFetch() });
    await expect(resolver.resolve(VALID_TOKEN)).rejects.toMatchObject({ status: 500 });
  });
});

describe('databricksHostOrigin', () => {
  it('accepts a bare workspace host or a URL', () => {
    expect(databricksHostOrigin({ DATABRICKS_HOST: 'dbc-1.cloud.databricks.com' })).toBe(
      'https://dbc-1.cloud.databricks.com',
    );
    expect(databricksHostOrigin({ DATABRICKS_HOST: 'https://dbc-1.cloud.databricks.com/' })).toBe(
      'https://dbc-1.cloud.databricks.com',
    );
    expect(databricksHostOrigin({})).toBeNull();
  });
});

describe('localDevUserFromEnv', () => {
  it('is off unless OD_LOCAL_DEV_USER is set', () => {
    expect(localDevUserFromEnv({})).toBeNull();
    expect(localDevUserFromEnv({ OD_LOCAL_DEV_USER: 'dev@example.com' })).toMatchObject({
      userName: 'dev@example.com',
      source: 'local-dev',
    });
  });

  it('refuses to run inside a deployed Databricks App', () => {
    expect(() =>
      localDevUserFromEnv({ OD_LOCAL_DEV_USER: 'dev@example.com', DATABRICKS_APP_NAME: 'open-design' }),
    ).toThrow(/must not be set in a Databricks App/);
    expect(() =>
      localDevUserFromEnv({ OD_LOCAL_DEV_USER: 'dev@example.com', DATABRICKS_APP_PORT: '8000' }),
    ).toThrow(/must not be set in a Databricks App/);
  });
});

describe('createDatabricksAuthMiddleware', () => {
  async function gatedApp(options: {
    localDev?: boolean;
    admit?: (req: express.Request) => boolean;
  } = {}) {
    const fetchImpl = scimFetch();
    const app = express();
    app.use(
      '/api',
      createDatabricksAuthMiddleware({
        resolver: createDatabricksIdentityResolver({ hostOrigin: 'https://dbc.example.com', fetch: fetchImpl }),
        localDevUser: options.localDev ? localDevUserFromEnv({ OD_LOCAL_DEV_USER: 'dev@example.com' }) : null,
        ...(options.admit ? { admitWithoutUser: options.admit } : {}),
      }),
    );
    // Reads the user both from the request and from the async scope after an
    // await, so a broken AsyncLocalStorage binding shows up here.
    app.get('/api/whoami', async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      res.json({ fromReq: getCurrentUser(req), fromScope: requireCurrentUser() });
    });
    app.get('/api/open', (req, res) => res.json({ user: getCurrentUser(req) }));
    const listening = await listen(app);
    servers.push(listening.server);
    return { ...listening, fetchImpl };
  }

  it('rejects a request without X-Forwarded-Access-Token with 401', async () => {
    const { url, fetchImpl } = await gatedApp();
    const resp = await fetch(`${url}/api/whoami`);
    expect(resp.status).toBe(401);
    expect(await resp.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores identity hint headers without a token', async () => {
    const { url } = await gatedApp();
    const resp = await fetch(`${url}/api/whoami`, {
      headers: { 'x-forwarded-email': 'ada@example.com', 'x-forwarded-user': '4242' },
    });
    expect(resp.status).toBe(401);
  });

  it('rejects an invalid forwarded token with 401', async () => {
    const { url } = await gatedApp();
    const resp = await fetch(`${url}/api/whoami`, { headers: { 'x-forwarded-access-token': 'forged' } });
    expect(resp.status).toBe(401);
  });

  it('authorizes a valid token and populates the current user', async () => {
    const { url } = await gatedApp();
    const resp = await fetch(`${url}/api/whoami`, { headers: { 'x-forwarded-access-token': VALID_TOKEN } });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { fromReq: unknown; fromScope: unknown };
    expect(body.fromReq).toMatchObject({ id: '4242', email: 'ada@example.com', groups: ['users', 'designers'] });
    expect(body.fromScope).toEqual(body.fromReq);
  });

  it('uses the local-dev user only when it is configured', async () => {
    const { url } = await gatedApp({ localDev: true });
    const resp = await fetch(`${url}/api/whoami`);
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { fromReq: unknown }).fromReq).toMatchObject({
      userName: 'dev@example.com',
      source: 'local-dev',
    });

    // A forwarded token still wins over the local-dev stand-in.
    const obo = await fetch(`${url}/api/whoami`, { headers: { 'x-forwarded-access-token': VALID_TOKEN } });
    expect(((await obo.json()) as { fromReq: unknown }).fromReq).toMatchObject({ id: '4242', source: 'obo' });
  });

  it('admits allow-listed requests without a user', async () => {
    const { url } = await gatedApp({ admit: (req) => req.path === '/open' });
    const resp = await fetch(`${url}/api/open`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ user: null });
  });
});

describe('isDatabricksAppSameOrigin', () => {
  it('accepts the app origin the request was addressed to', () => {
    expect(isDatabricksAppSameOrigin('https://od-123.aws.databricksapps.com', 'od-123.aws.databricksapps.com')).toBe(true);
    expect(
      isDatabricksAppSameOrigin('https://od-123.aws.databricksapps.com', '127.0.0.1:8000', 'od-123.aws.databricksapps.com'),
    ).toBe(true);
  });

  it('rejects sibling apps, plain http, and non-databricksapps hosts', () => {
    expect(isDatabricksAppSameOrigin('https://evil-1.aws.databricksapps.com', 'od-123.aws.databricksapps.com')).toBe(false);
    expect(isDatabricksAppSameOrigin('http://od-123.aws.databricksapps.com', 'od-123.aws.databricksapps.com')).toBe(false);
    expect(isDatabricksAppSameOrigin('https://example.com', 'example.com')).toBe(false);
  });
});

describe('startServer /api gate', () => {
  const saved = {
    localDev: process.env.OD_LOCAL_DEV_USER,
    host: process.env.DATABRICKS_HOST,
  };
  let scim: Server;
  let daemon: { url: string; server: Server; shutdown?: () => Promise<void> | void } | undefined;

  beforeEach(async () => {
    const scimApp = express();
    scimApp.get('/api/2.0/preview/scim/v2/Me', (req, res) => {
      if (req.get('authorization') !== `Bearer ${VALID_TOKEN}`) return res.status(401).json({});
      res.json(SCIM_ME);
    });
    const listening = await listen(scimApp);
    scim = listening.server;
    delete process.env.OD_LOCAL_DEV_USER;
    process.env.DATABRICKS_HOST = listening.url;
    daemon = (await startServer({ port: 0, host: '127.0.0.1', returnServer: true })) as typeof daemon;
  });

  afterEach(async () => {
    if (daemon?.shutdown) await Promise.resolve(daemon.shutdown());
    if (daemon) await new Promise<void>((r) => daemon!.server.close(() => r()));
    daemon = undefined;
    await new Promise<void>((r) => scim.close(() => r()));
    if (saved.localDev === undefined) delete process.env.OD_LOCAL_DEV_USER;
    else process.env.OD_LOCAL_DEV_USER = saved.localDev;
    if (saved.host === undefined) delete process.env.DATABRICKS_HOST;
    else process.env.DATABRICKS_HOST = saved.host;
  });

  it('keeps probes open, rejects protected routes without a token, and admits a valid OBO token', async () => {
    const health = await fetch(`${daemon!.url}/api/health`);
    expect(health.status).toBe(200);

    const anonymous = await fetch(`${daemon!.url}/api/projects`);
    expect(anonymous.status).toBe(401);

    const forged = await fetch(`${daemon!.url}/api/projects`, {
      headers: { 'x-forwarded-access-token': 'forged' },
    });
    expect(forged.status).toBe(401);

    const authorized = await fetch(`${daemon!.url}/api/projects`, {
      headers: { 'x-forwarded-access-token': VALID_TOKEN },
    });
    expect(authorized.status).toBe(200);
  });
});
