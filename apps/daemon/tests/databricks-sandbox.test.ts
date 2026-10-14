import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSandboxClient,
  createSandboxShell,
  SANDBOX_PROJECTS_ROOT,
  SandboxUnavailableError,
  sandboxIdForUser,
  sandboxShellFromEnv,
  type SandboxClient,
  type SandboxExecResult,
} from '../src/databricks/sandbox.js';

const HOST = 'https://ws.example.com';

// A sandbox that is a temp directory on this machine: exec runs the real
// bash/python sync scripts locally, with the sandbox projects root mapped
// onto `remoteRoot`. That exercises the transfer logic itself, not a mock of it.
function localSandbox(remoteRoot: string) {
  const execs: string[] = [];
  const client: SandboxClient = {
    sandboxId: 'opendesign-test',
    async probe() {},
    async ensureRunning() {},
    exec(script, args = [], timeoutMs = 60_000) {
      execs.push(script);
      const mapped = args.map((arg) => arg.split(SANDBOX_PROJECTS_ROOT).join(remoteRoot));
      return new Promise<SandboxExecResult>((resolve) => {
        execFile('/bin/bash', ['-c', script, 'od', ...mapped], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
          const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((error as unknown as { code: number }).code)
            : error ? 1 : 0;
          resolve({ status: 'EXECUTE_COMMAND_STATUS_COMPLETED', exitCode: code, stdout, stderr, truncated: false });
        });
      });
    },
  };
  return { client, execs };
}

let dirs: string[] = [];
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
beforeEach(() => {
  dirs = [];
});
afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(files: Record<string, string | Buffer>): Promise<string> {
  const root = await temp('od-sbx-local-');
  const dir = path.join(root, 'proj-1');
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('sandbox shell', () => {
  it('runs a command against a copy of the project and syncs creations and deletions back', async () => {
    const projectDir = await project({ 'index.html': '<h1>v1</h1>', 'old.txt': 'remove me', 'node_modules/x/i.js': 'skip' });
    const remoteRoot = await temp('od-sbx-remote-');
    const { client, execs } = localSandbox(remoteRoot);
    const shell = createSandboxShell({ client, projectDir });

    const result = await shell.execute({ command: 'cat index.html && mkdir -p out && echo made > out/new.txt && rm old.txt' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('<h1>v1</h1>');
    expect(result.content).toContain('[project: 1 file(s) created or changed, 1 deleted]');
    expect(await readFile(path.join(projectDir, 'out/new.txt'), 'utf8')).toBe('made\n');
    await expect(stat(path.join(projectDir, 'old.txt'))).rejects.toThrow();
    // Excluded trees never cross.
    await expect(stat(path.join(remoteRoot, 'proj-1/node_modules'))).rejects.toThrow();

    // A local edit reaches the sandbox; an unchanged project uploads nothing.
    await writeFile(path.join(projectDir, 'index.html'), '<h1>v2</h1>');
    expect((await shell.execute({ command: 'cat index.html' })).content).toContain('<h1>v2</h1>');
    execs.length = 0;
    const quiet = await shell.execute({ command: 'true' });
    expect(quiet.content).toBe('(no output)');
    // Two listings and the command: no push, no pull.
    expect(execs).toHaveLength(3);
  });

  it('moves multi-megabyte files both ways through chunked transfers', async () => {
    const payload = randomBytes(1_500_000);
    const projectDir = await project({ 'assets/photo.bin': payload });
    const { client } = localSandbox(await temp('od-sbx-remote-'));
    const shell = createSandboxShell({ client, projectDir });

    const result = await shell.execute({ command: 'wc -c < assets/photo.bin && head -c 2000000 /dev/urandom > generated.bin' });
    expect(result.content).toContain('1500000');
    expect((await stat(path.join(projectDir, 'generated.bin'))).size).toBe(2_000_000);
  });

  it('reports a failing command with its exit code and still syncs its output', async () => {
    const projectDir = await project({});
    const { client } = localSandbox(await temp('od-sbx-remote-'));
    const shell = createSandboxShell({ client, projectDir });
    const result = await shell.execute({ command: 'echo partial > log.txt; echo oops >&2; exit 3' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('[stderr]\noops');
    expect(result.content).toContain('[exit code 3]');
    expect(await readFile(path.join(projectDir, 'log.txt'), 'utf8')).toBe('partial\n');
  });

  it('refuses sandbox paths that escape the project', async () => {
    const projectDir = await project({});
    const remoteRoot = await temp('od-sbx-remote-');
    const { client } = localSandbox(remoteRoot);
    const shell = createSandboxShell({ client, projectDir });
    // A symlink pointing outside is not listed, so nothing outside is read back.
    const result = await shell.execute({ command: `ln -s ${tmpdir()} escape && echo ok` });
    expect(result.content).toContain('ok');
    await expect(stat(path.join(projectDir, 'escape'))).rejects.toThrow();
  });
});

describe('sandbox client', () => {
  function api(states: Array<string | null>, { createStatus = 200 }: { createStatus?: number } = {}) {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const url = String(input).replace(HOST, '');
      calls.push(`${init.method} ${url}`);
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer user-token');
      if (init.method === 'GET') {
        const state = states.length > 1 ? states.shift()! : states[0]!;
        return state === null
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify({ status: { state } }), { status: 200 });
      }
      if (url.startsWith('/api/2.0/sandboxes?')) {
        expect(JSON.parse(String(init.body))).toMatchObject({
          spec: { identity: { databricks_access_token_included: false } },
        });
        return new Response('{}', { status: createStatus });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('creates a missing sandbox and waits for it, without the user credentials inside', async () => {
    const { calls, fetchImpl } = api([null, 'SANDBOX_STATE_PENDING', 'SANDBOX_STATE_RUNNING']);
    const client = createSandboxClient({ host: HOST, token: 'user-token', sandboxId: 'opendesign-42', fetchImpl, sleep: async () => {} });
    await client.ensureRunning();
    expect(calls).toEqual([
      'GET /api/2.0/sandboxes/opendesign-42',
      'POST /api/2.0/sandboxes?sandbox_id=opendesign-42',
      'GET /api/2.0/sandboxes/opendesign-42',
      'GET /api/2.0/sandboxes/opendesign-42',
    ]);
  });

  it('starts a stopped sandbox', async () => {
    const { calls, fetchImpl } = api(['SANDBOX_STATE_STOPPED', 'SANDBOX_STATE_RUNNING']);
    const client = createSandboxClient({ host: HOST, token: 'user-token', sandboxId: 'opendesign-42', fetchImpl, sleep: async () => {} });
    await client.ensureRunning();
    expect(calls).toContain('POST /api/2.0/sandboxes/opendesign-42/start');
  });

  it('explains a missing scope or preview', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const client = createSandboxClient({ host: HOST, token: 'user-token', sandboxId: 'opendesign-42', fetchImpl });
    await expect(client.probe()).rejects.toThrow(SandboxUnavailableError);
    await expect(client.probe()).rejects.toThrow('"sandbox" user API scope');
  });

  it('names one sandbox per user', () => {
    expect(sandboxIdForUser('6210746108732282')).toBe('opendesign-6210746108732282');
    expect(sandboxIdForUser('A_b.C')).toBe('opendesign-a-b-c');
  });
});

describe('sandbox shell from the run environment', () => {
  const ok = (async () => new Response(JSON.stringify({ status: { state: 'SANDBOX_STATE_RUNNING' } }))) as unknown as typeof fetch;
  it('is off unless enabled and given a user id', async () => {
    expect(await sandboxShellFromEnv({}, HOST, 't', '/p', ok)).toBeNull();
    expect(await sandboxShellFromEnv({ OD_DATABRICKS_SANDBOX: '1' }, HOST, 't', '/p', ok)).toBeNull();
    expect(await sandboxShellFromEnv({ OD_DATABRICKS_SANDBOX: '1', OD_DATABRICKS_USER_ID: '42' }, HOST, 't', '/p', ok)).not.toBeNull();
  });
  it('falls back to no shell when the user cannot use sandboxes', async () => {
    const denied = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    expect(await sandboxShellFromEnv({ OD_DATABRICKS_SANDBOX: '1', OD_DATABRICKS_USER_ID: '42' }, HOST, 't', '/p', denied)).toBeNull();
  });
});
