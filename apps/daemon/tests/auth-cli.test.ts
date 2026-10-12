import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

let stub: http.Server | null = null;

afterEach(async () => {
  if (stub) await new Promise<void>((resolve) => stub!.close(() => resolve()));
  stub = null;
});

async function startSessionStub(body: unknown): Promise<{ baseUrl: string; paths: string[] }> {
  const paths: string[] = [];
  stub = http.createServer((req, res) => {
    paths.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, paths };
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT,
      env,
      timeout: 15_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | null };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code ?? 1 };
  }
}

describe('od auth whoami', () => {
  const session = {
    provider: 'databricks',
    user: {
      id: '42',
      userName: 'ada@example.com',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      groups: ['designers'],
    },
  };

  it('prints the signed-in Databricks user from /api/auth/session', async () => {
    const { baseUrl, paths } = await startSessionStub(session);
    const result = await runCli(['auth', 'whoami', '--daemon-url', baseUrl]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('Signed in with Databricks as Ada Lovelace <ada@example.com>\n');
    expect(paths).toEqual(['/api/auth/session']);
  });

  it('emits the raw session with --json', async () => {
    const { baseUrl } = await startSessionStub(session);
    const result = await runCli(['auth', 'whoami', '--json', '--daemon-url', baseUrl]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(session);
  });

  it('reports local daemon auth', async () => {
    const { baseUrl } = await startSessionStub({ provider: 'local', user: null });
    const result = await runCli(['auth', 'whoami', '--daemon-url', baseUrl]);
    expect(result.stdout).toBe('Local daemon auth (no per-user identity).\n');
  });

  it('rejects an unknown auth subcommand', async () => {
    const result = await runCli(['auth', 'login']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown subcommand: od auth login');
  });
});
