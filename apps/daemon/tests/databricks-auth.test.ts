// Databricks Apps on-behalf-of auth (OD_AUTH_MODE=databricks), exercised
// through the real server wiring: the Apps proxy forwards the signed-in
// user's token in X-Forwarded-Access-Token, the daemon verifies it against
// SCIM Me (a local stub here), and refuses proxied requests without one.

import http, { type OutgoingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

const APP_HOST = 'dbrx-open-design-123.aws.databricksapps.com';
const APP_ORIGIN = `https://${APP_HOST}`;
const GOOD_TOKEN = 'obo-token-good';

const ENV_KEYS = ['OD_AUTH_MODE', 'DATABRICKS_HOST', 'OD_API_TOKEN', 'OD_DISABLE_API_AUTH'] as const;
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let scim: Server;
let scimHost = '';
let scimAuthorizations: string[] = [];
let daemon: { server: Server; url: string; shutdown?: () => Promise<void> | void } | undefined;

beforeAll(async () => {
  scim = http.createServer((req, res) => {
    scimAuthorizations.push(String(req.headers.authorization ?? ''));
    if (req.url !== '/api/2.0/preview/scim/v2/Me') {
      res.statusCode = 404;
      return res.end();
    }
    if (req.headers.authorization !== `Bearer ${GOOD_TOKEN}`) {
      res.statusCode = 401;
      return res.end('{}');
    }
    res.setHeader('content-type', 'application/scim+json');
    res.end(JSON.stringify({
      id: '1234',
      userName: 'ada@example.com',
      displayName: 'Ada Lovelace',
      emails: [{ value: 'ada@example.com', primary: true }],
      groups: [{ display: 'designers', value: '99' }],
    }));
  });
  await new Promise<void>((resolve) => scim.listen(0, '127.0.0.1', resolve));
  scimHost = `http://127.0.0.1:${(scim.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => scim.close(() => resolve()));
});

afterEach(async () => {
  if (daemon?.shutdown) await Promise.resolve(daemon.shutdown());
  if (daemon) await new Promise<void>((resolve) => daemon!.server.close(() => resolve()));
  daemon = undefined;
  scimAuthorizations = [];
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

async function startDatabricksDaemon(host = '127.0.0.1'): Promise<string> {
  process.env.OD_AUTH_MODE = 'databricks';
  process.env.DATABRICKS_HOST = scimHost;
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  daemon = (await startServer({ port: 0, host, returnServer: true })) as typeof daemon;
  const port = (daemon!.server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

function request(
  url: string,
  { method = 'GET', headers = {} }: { method?: string; headers?: OutgoingHttpHeaders } = {},
): Promise<{ status: number | undefined; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = text;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const proxied = (extra: OutgoingHttpHeaders = {}): OutgoingHttpHeaders => ({
  'x-forwarded-host': APP_HOST,
  'x-forwarded-email': 'ada@example.com',
  'x-real-ip': '10.1.2.3',
  ...extra,
});

describe('Databricks auth mode startup', () => {
  it('binds a public host without OD_API_TOKEN', async () => {
    await startDatabricksDaemon('0.0.0.0');
    expect(daemon?.server.listening).toBe(true);
  });

  it('refuses to mix with OD_DISABLE_API_AUTH', async () => {
    process.env.OD_AUTH_MODE = 'databricks';
    process.env.DATABRICKS_HOST = scimHost;
    process.env.OD_DISABLE_API_AUTH = '1';
    await expect(startServer({ port: 0, host: '127.0.0.1', returnServer: true }))
      .rejects.toThrow(/replaces OD_API_TOKEN and OD_DISABLE_API_AUTH/);
  });

  it('refuses to start without DATABRICKS_HOST', async () => {
    process.env.OD_AUTH_MODE = 'databricks';
    delete process.env.DATABRICKS_HOST;
    await expect(startServer({ port: 0, host: '127.0.0.1', returnServer: true }))
      .rejects.toThrow(/requires DATABRICKS_HOST/);
  });

  it('rejects an unknown OD_AUTH_MODE', async () => {
    process.env.OD_AUTH_MODE = 'okta';
    await expect(startServer({ port: 0, host: '127.0.0.1', returnServer: true }))
      .rejects.toThrow(/OD_AUTH_MODE/);
  });
});

describe('Databricks auth mode requests', () => {
  it('returns the SCIM-verified user for a proxied request with a forwarded token', async () => {
    const base = await startDatabricksDaemon();
    const res = await request(`${base}/api/auth/session`, {
      headers: proxied({ 'x-forwarded-access-token': GOOD_TOKEN }),
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      provider: 'databricks',
      user: {
        id: '1234',
        userName: 'ada@example.com',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        groups: ['designers'],
      },
    });
    expect(scimAuthorizations).toEqual([`Bearer ${GOOD_TOKEN}`]);
  });

  it('fails closed on a proxied request without a forwarded token', async () => {
    const base = await startDatabricksDaemon();
    const res = await request(`${base}/api/projects`, { headers: proxied() });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('DATABRICKS_AUTH_REQUIRED');
    expect(scimAuthorizations).toEqual([]);
  });

  it('fails closed when SCIM rejects the forwarded token', async () => {
    const base = await startDatabricksDaemon();
    const res = await request(`${base}/api/projects`, {
      headers: proxied({ 'x-forwarded-access-token': 'forged' }),
    });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('DATABRICKS_AUTH_REQUIRED');
  });

  it('keeps health / version probes open', async () => {
    const base = await startDatabricksDaemon();
    expect((await request(`${base}/api/health`, { headers: proxied() })).status).toBe(200);
    expect((await request(`${base}/api/version`, { headers: proxied() })).status).toBe(200);
  });

  it('admits in-container loopback callers without a user', async () => {
    const base = await startDatabricksDaemon();
    const res = await request(`${base}/api/auth/session`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ provider: 'databricks', user: null });
  });

  it('accepts the app origin named by X-Forwarded-Host and still rejects other origins', async () => {
    const base = await startDatabricksDaemon();
    const sameOrigin = await request(`${base}/api/app-config`, {
      headers: proxied({ 'x-forwarded-access-token': GOOD_TOKEN, origin: APP_ORIGIN }),
    });
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.json.config.onboardingCompleted).toBe(true);

    const crossOrigin = await request(`${base}/api/app-config`, {
      headers: proxied({ 'x-forwarded-access-token': GOOD_TOKEN, origin: 'https://evil.example' }),
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('refuses external sign-in flows', async () => {
    const base = await startDatabricksDaemon();
    const res = await request(`${base}/api/integrations/vela/login`, {
      method: 'POST',
      headers: proxied({ 'x-forwarded-access-token': GOOD_TOKEN, origin: APP_ORIGIN }),
    });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('EXTERNAL_AUTH_DISABLED');
  });
});

describe('local auth mode', () => {
  it('reports the local provider with no user', async () => {
    delete process.env.OD_AUTH_MODE;
    daemon = (await startServer({ port: 0, host: '127.0.0.1', returnServer: true })) as typeof daemon;
    const port = (daemon!.server.address() as AddressInfo).port;
    const res = await request(`http://127.0.0.1:${port}/api/auth/session`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ provider: 'local', user: null });
  });
});
