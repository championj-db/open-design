import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDaemonSandboxClient,
  createSandboxShell,
  SANDBOX_EXEC_TOOL_ENDPOINT,
  SANDBOX_PROJECTS_ROOT,
  SandboxUnavailableError,
  sandboxShellFromEnv,
  type SandboxClient,
  type SandboxExecResult,
} from '../src/databricks/sandbox.js';

// A sandbox that is a temp directory on this machine: exec runs the real
// bash/python sync scripts locally, with the sandbox projects root mapped
// onto `remoteRoot`. That exercises the transfer logic itself, not a mock of it.
function localSandbox(remoteRoot: string) {
  const execs: string[] = [];
  const client: SandboxClient = {
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

describe('daemon sandbox client', () => {
  it('sends each command to the daemon broker with the run tool token', async () => {
    const requests: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ status: 'EXECUTE_COMMAND_STATUS_COMPLETED', exitCode: 0, stdout: 'hi', stderr: '', truncated: false }));
    }) as unknown as typeof fetch;
    const client = createDaemonSandboxClient({ daemonUrl: 'http://127.0.0.1:7456/', toolToken: 'odtt_x', fetchImpl });
    expect((await client.exec('echo "$1"', ['hi'], 5_000)).stdout).toBe('hi');
    expect(requests).toEqual([{
      url: `http://127.0.0.1:7456${SANDBOX_EXEC_TOOL_ENDPOINT}`,
      auth: 'Bearer odtt_x',
      body: { script: 'echo "$1"', args: ['hi'], timeoutMs: 5_000 },
    }]);
  });

  it('turns a daemon error into a sandbox error the model can read', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 'SANDBOX_UNAVAILABLE', message: 'no preview' } }), { status: 502 })) as unknown as typeof fetch;
    const client = createDaemonSandboxClient({ daemonUrl: 'http://d', toolToken: 't', fetchImpl });
    await expect(client.exec('true')).rejects.toThrow(SandboxUnavailableError);
    await expect(client.exec('true')).rejects.toThrow('no preview');
  });
});

describe('sandbox shell from the run environment', () => {
  it('is on only when the daemon enabled it and gave the run a tool token', () => {
    const base = { OD_DAEMON_URL: 'http://d', OD_TOOL_TOKEN: 't' };
    expect(sandboxShellFromEnv({ ...base }, '/p')).toBeNull();
    expect(sandboxShellFromEnv({ ...base, OD_DATABRICKS_SANDBOX: '0' }, '/p')).toBeNull();
    expect(sandboxShellFromEnv({ OD_DATABRICKS_SANDBOX: '1', OD_DAEMON_URL: 'http://d' }, '/p')).toBeNull();
    expect(sandboxShellFromEnv({ ...base, OD_DATABRICKS_SANDBOX: '1' }, '/p')).not.toBeNull();
  });
});
