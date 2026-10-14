import { describe, expect, it } from 'vitest';

import { createSandboxApi, createSandboxBroker, SESSION_SANDBOX_PREFIX, type SandboxApi } from '../src/databricks/sandbox-broker.js';
import { SandboxUnavailableError } from '../src/databricks/sandbox.js';

const quiet = { info() {}, warn() {} };

function fakeApi(existing: string[] = []) {
  const sandboxes = new Map<string, string>(existing.map((id) => [id, 'SANDBOX_STATE_STOPPED']));
  const calls: string[] = [];
  let listFails = false;
  const api: SandboxApi = {
    async state(id) {
      return sandboxes.get(id) ?? null;
    },
    async create(id) {
      calls.push(`create ${id}`);
      // Comes up on the next poll.
      sandboxes.set(id, 'SANDBOX_STATE_PENDING');
      setTimeout(() => sandboxes.set(id, 'SANDBOX_STATE_RUNNING'), 0);
    },
    async start(id) {
      calls.push(`start ${id}`);
      sandboxes.set(id, 'SANDBOX_STATE_RUNNING');
    },
    async remove(id) {
      calls.push(`remove ${id}`);
      sandboxes.delete(id);
    },
    async list() {
      if (listFails) throw new SandboxUnavailableError('HTTP 403');
      return [...sandboxes.keys()];
    },
    async exec(id, script) {
      calls.push(`exec ${id} ${script}`);
      return { status: 'EXECUTE_COMMAND_STATUS_COMPLETED', exitCode: 0, stdout: id, stderr: '', truncated: false };
    },
  };
  return { api, sandboxes, calls, failList: () => { listFails = true; } };
}

function broker(api: SandboxApi, clock = { t: 0 }) {
  let n = 0;
  return createSandboxBroker({
    api,
    idleMs: 1000,
    now: () => clock.t,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    newSandboxId: () => `${SESSION_SANDBOX_PREFIX}${++n}`,
    log: quiet,
  });
}

describe('sandbox broker', () => {
  it('gives each user conversation its own sandbox and reuses it within the conversation', async () => {
    const { api, calls } = fakeApi();
    const b = broker(api);
    const alice1 = await b.exec({ userId: 'alice', conversationId: 'c1' }, 'a', [], 1000);
    const alice1Again = await b.exec({ userId: 'alice', conversationId: 'c1' }, 'b', [], 1000);
    const alice2 = await b.exec({ userId: 'alice', conversationId: 'c2' }, 'c', [], 1000);
    const bob1 = await b.exec({ userId: 'bob', conversationId: 'c1' }, 'd', [], 1000);
    expect(alice1Again.stdout).toBe(alice1.stdout);
    expect(new Set([alice1.stdout, alice2.stdout, bob1.stdout]).size).toBe(3);
    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(3);
  });

  it('deletes idle sandboxes, never one with a command still running', async () => {
    const { api, sandboxes } = fakeApi();
    const clock = { t: 0 };
    const b = broker(api, clock);
    await b.exec({ userId: 'u', conversationId: 'idle' }, 'x', [], 1000);
    clock.t = 500;
    await b.exec({ userId: 'u', conversationId: 'recent' }, 'x', [], 1000);
    clock.t = 1200;
    await b.sweep();
    expect([...sandboxes.keys()]).toEqual([`${SESSION_SANDBOX_PREFIX}2`]);
    expect(b.sessionCount).toBe(1);

    // A conversation that comes back after its sandbox was deleted gets a fresh one.
    const again = await b.exec({ userId: 'u', conversationId: 'idle' }, 'x', [], 1000);
    expect(again.stdout).toBe(`${SESSION_SANDBOX_PREFIX}3`);

    await b.stop();
    expect(sandboxes.size).toBe(0);
  });

  it('deletes sandboxes a previous daemon left behind, and only its own', async () => {
    const { api, sandboxes } = fakeApi([`${SESSION_SANDBOX_PREFIX}old`, 'someone-elses']);
    const b = broker(api);
    expect(await b.init()).toBe(true);
    expect([...sandboxes.keys()]).toEqual(['someone-elses']);
    await b.stop();
  });

  it('reports sandboxes as unavailable when the service principal cannot list them', async () => {
    const fake = fakeApi();
    fake.failList();
    expect(await broker(fake.api).init()).toBe(false);
  });

  it('starts a sandbox Databricks stopped for inactivity and retries the command', async () => {
    const { api, sandboxes, calls } = fakeApi();
    const id = `${SESSION_SANDBOX_PREFIX}1`;
    const realExec = api.exec;
    api.exec = async (sandboxId, ...rest) => {
      if (sandboxes.get(sandboxId) !== 'SANDBOX_STATE_RUNNING') throw new SandboxUnavailableError('HTTP 409 not running');
      return realExec(sandboxId, ...rest);
    };
    const b = broker(api);
    await b.exec({ userId: 'u', conversationId: 'c' }, 'x', [], 1000);
    sandboxes.set(id, 'SANDBOX_STATE_STOPPED');
    expect((await b.exec({ userId: 'u', conversationId: 'c' }, 'y', [], 1000)).stdout).toBe(id);
    expect(calls).toContain(`start ${id}`);
    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(1);
  });
});

describe('sandbox REST api', () => {
  it('creates sandboxes without credentials inside, as the service principal', async () => {
    const requests: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({
        method: init.method!,
        url,
        auth: new Headers(init.headers).get('authorization'),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (init.method === 'GET' && url.endsWith('/sandboxes')) {
        return new Response(JSON.stringify({ sandboxes: [{ name: 'sandboxes/od-session-a' }], next_page_token: 'p2' }));
      }
      if (init.method === 'GET' && url.includes('page_token=p2')) {
        return new Response(JSON.stringify({ sandboxes: [{ name: 'sandboxes/od-session-b' }] }));
      }
      if (init.method === 'DELETE') return new Response('{}', { status: 404 });
      return new Response('{}');
    }) as unknown as typeof fetch;
    const api = createSandboxApi({ host: 'https://ws/', getToken: async () => 'sp-token', fetchImpl });
    await api.create('od-session-x', 'OpenDesign session');
    expect(await api.list()).toEqual(['od-session-a', 'od-session-b']);
    // Deleting one that is already gone is not an error.
    await api.remove('od-session-x');
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://ws/api/2.0/sandboxes?sandbox_id=od-session-x',
      auth: 'Bearer sp-token',
      body: { spec: { identity: { databricks_access_token_included: false } } },
    });
  });

  it('explains a refusal', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const api = createSandboxApi({ host: 'https://ws', getToken: async () => 't', fetchImpl });
    await expect(api.list()).rejects.toThrow("service principal needs access");
  });
});
