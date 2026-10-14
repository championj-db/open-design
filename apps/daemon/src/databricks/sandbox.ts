import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { resolveInsideProject, type HarnessToolDefinition, type HarnessToolResult } from './harness-tools.js';

// A shell for the Databricks agent, run in the signed-in user's own
// Databricks Sandbox (serverless, isolated, Beta) instead of the app
// container that every user shares. The harness drives it through the
// Sandbox REST API with the user's on-behalf-of token, so each user gets one
// sandbox — `opendesign-<scim id>`, reused across sessions, stopped by
// Databricks when idle — that only they own and are billed for.
//
// The sandbox cannot see the app container's disk, so each Bash call brings
// the project across and back:
//
//   1. push: project files that differ from the sandbox copy go up, and files
//      deleted locally are deleted there;
//   2. the command runs in the project's sandbox directory;
//   3. pull: files the command created or changed come back into the project,
//      and files it deleted are deleted locally.
//
// Both sides keep each file's mtime, so "differs" is a size + mtime compare
// and an unchanged project costs two listings. Transfers are gzip+base64
// carried in exec arguments and output, chunked under the API's limits.

export const SANDBOX_PROJECTS_ROOT = '/home/sandbox-agent/opendesign/projects';
const INACTIVITY_TIMEOUT_SECONDS = 900;
const START_TIMEOUT_MS = 180_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
// Linux caps one argument at 128 KiB, an exec request at 4 MiB, and the API
// truncates output at 512 KiB.
const ARG_CHUNK_CHARS = 96 * 1024;
// Eight chunks keeps one exec under every platform's total-argument limit.
const ARGS_PER_EXEC = 8;
const OUTPUT_CHUNK_CHARS = 384 * 1024;
const MAX_SYNC_FILE_BYTES = 25 * 1024 * 1024;
const MAX_RESULT_CHARS = 20_000;
// Never synced either way: dependency trees, VCS data, and the daemon's own
// per-project bookkeeping.
export const SANDBOX_SYNC_EXCLUDED_DIRS = ['node_modules', '.git', '.od', '.file-versions', '.next', '__pycache__', '.venv', '.cache'];

export const BASH_TOOL: HarnessToolDefinition = {
  type: 'function',
  function: {
    name: 'Bash',
    description:
      'Run a bash command in your own isolated Linux sandbox (Ubuntu, Python 3, Node 24, git). '
      + 'The working directory is a copy of the project: files you create or change there are copied back into the project afterwards. '
      + 'Installed packages persist between commands. Prefer the file tools for reading and editing project files.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run.' },
        timeout: { type: 'number', description: `Timeout in milliseconds (default ${DEFAULT_COMMAND_TIMEOUT_MS}, max ${MAX_COMMAND_TIMEOUT_MS}).` },
        description: { type: 'string', description: 'A few words on what the command does.' },
      },
      required: ['command'],
    },
  },
};

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

export interface SandboxExecResult {
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface SandboxClient {
  readonly sandboxId: string;
  /** Throws SandboxUnavailableError when this user cannot use sandboxes. */
  probe(): Promise<void>;
  /** Create or start the sandbox and wait until it is running. */
  ensureRunning(): Promise<void>;
  /** `bash -c script` with positional `args` ($1, $2, …). */
  exec(script: string, args?: string[], timeoutMs?: number): Promise<SandboxExecResult>;
}

/** One sandbox per user: a stable, API-safe id derived from the SCIM id. */
export function sandboxIdForUser(userId: string): string {
  const safe = userId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (safe === '') throw new SandboxUnavailableError('No user id to name a sandbox after.');
  return `opendesign-${safe}`.slice(0, 63);
}

export function createSandboxClient({
  host,
  token,
  sandboxId,
  fetchImpl = fetch,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: {
  host: string;
  token: string;
  sandboxId: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}): SandboxClient {
  const base = host.replace(/\/+$/, '');
  const name = `sandboxes/${sandboxId}`;
  async function call(method: string, url: string, body?: unknown): Promise<Response> {
    return fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function unavailable(response: Response, action: string): Promise<never> {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    if (response.status === 401 || response.status === 403) {
      throw new SandboxUnavailableError(
        `Databricks refused to ${action} (HTTP ${response.status}). The app needs the "sandbox" user API scope, `
        + `and the workspace needs the Databricks Sandbox preview. ${detail}`.trim(),
      );
    }
    throw new SandboxUnavailableError(`Could not ${action}: HTTP ${response.status}. ${detail}`.trim());
  }
  async function state(): Promise<string | null> {
    const response = await call('GET', `${base}/api/2.0/${name}`);
    if (response.status === 404) return null;
    if (!response.ok) return unavailable(response, 'read your sandbox');
    const body = (await response.json().catch(() => null)) as { status?: { state?: unknown } } | null;
    return typeof body?.status?.state === 'string' ? body.status.state : 'SANDBOX_STATE_UNSPECIFIED';
  }
  return {
    sandboxId,
    async probe() {
      await state();
    },
    async ensureRunning() {
      const deadline = now() + START_TIMEOUT_MS;
      let current = await state();
      if (current === null) {
        const response = await call('POST', `${base}/api/2.0/sandboxes?sandbox_id=${encodeURIComponent(sandboxId)}`, {
          display_name: 'OpenDesign',
          // Commands come from a model; do not hand them the user's
          // Databricks credentials as well.
          spec: {
            compute: { inactivity_timeout: `${INACTIVITY_TIMEOUT_SECONDS}s` },
            identity: { databricks_access_token_included: false },
          },
        });
        // A concurrent run may have created it first.
        if (!response.ok && response.status !== 409) await unavailable(response, 'create your sandbox');
        current = await state();
      }
      while (current !== 'SANDBOX_STATE_RUNNING') {
        if (current === 'SANDBOX_STATE_STOPPED') {
          const response = await call('POST', `${base}/api/2.0/${name}/start`);
          if (!response.ok && response.status !== 409) await unavailable(response, 'start your sandbox');
        }
        if (now() > deadline) throw new SandboxUnavailableError('Your sandbox did not start within 3 minutes. Try again.');
        await sleep(2_000);
        current = await state();
      }
    },
    async exec(script, args = [], timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
      const response = await call('POST', `${base}/api/2.0/sandbox-exec/${name}/exec-sync`, {
        cmd: '/bin/bash',
        args: ['-c', script, 'od', ...args],
        execution_timeout: `${Math.ceil(timeoutMs / 1000)}s`,
      });
      if (!response.ok) return unavailable(response, 'run a command in your sandbox');
      const body = (await response.json()) as Record<string, unknown>;
      return {
        status: typeof body.status === 'string' ? body.status : 'EXECUTE_COMMAND_STATUS_UNSPECIFIED',
        exitCode: typeof body.exit_code === 'number' ? body.exit_code : null,
        stdout: typeof body.stdout === 'string' ? body.stdout : '',
        stderr: typeof body.stderr === 'string' ? body.stderr : '',
        truncated: body.truncated === true,
      };
    },
  };
}

type Listing = Record<string, [size: number, mtimeMs: number]>;

const EXCLUDED_JSON = JSON.stringify(SANDBOX_SYNC_EXCLUDED_DIRS);

// Python helpers run in the sandbox. Paths are relative to the project dir.
const PY_LIST = `
import json, os, sys
root = sys.argv[1]; skip = set(${EXCLUDED_JSON}); out = {}
for d, dirs, files in os.walk(root):
    dirs[:] = [x for x in dirs if x not in skip]
    for f in files:
        p = os.path.join(d, f)
        if os.path.islink(p) or not os.path.isfile(p): continue
        s = os.stat(p); out[os.path.relpath(p, root)] = [s.st_size, s.st_mtime_ns // 1000000]
print(json.dumps(out))
`;
const PY_UNPACK = `
import base64, gzip, json, os, sys
root = os.path.realpath(sys.argv[1]); blob = sys.argv[2]
bundle = json.loads(gzip.decompress(base64.b64decode(open(blob).read())))
os.remove(blob)
def inside(rel):
    p = os.path.realpath(os.path.join(root, rel))
    if not p.startswith(root + os.sep): raise SystemExit('refusing ' + rel)
    return p
for rel in bundle['delete']:
    p = inside(rel)
    if os.path.isfile(p): os.remove(p)
for f in bundle['files']:
    p = inside(f['p']); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'wb').write(base64.b64decode(f['d'])); os.utime(p, ns=(f['m'] * 1000000, f['m'] * 1000000))
`;
const PY_PACK = `
import base64, gzip, json, os, sys
root = sys.argv[1]; out = sys.argv[2]; files = []
for rel in json.loads(sys.argv[3]):
    p = os.path.join(root, rel)
    s = os.stat(p); files.append({'p': rel, 'd': base64.b64encode(open(p, 'rb').read()).decode(), 'm': s.st_mtime_ns // 1000000})
open(out, 'w').write(base64.b64encode(gzip.compress(json.dumps(files).encode())).decode())
print(os.path.getsize(out))
`;

/**
 * The harness's Bash tool for one run: syncs `projectDir` with the user's
 * sandbox around each command. Construct once per run.
 */
export function createSandboxShell({ client, projectDir }: { client: SandboxClient; projectDir: string }) {
  const projectId = path.basename(projectDir);
  const remoteDir = `${SANDBOX_PROJECTS_ROOT}/${projectId}`;
  const scratch = `/tmp/opendesign-${projectId}`;

  async function run(script: string, args: string[] = [], timeoutMs?: number): Promise<string> {
    const result = await client.exec(script, args, timeoutMs);
    if (result.status !== 'EXECUTE_COMMAND_STATUS_COMPLETED' || result.exitCode !== 0) {
      throw new Error(`sandbox sync step failed (${result.status}, exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
    }
    if (result.truncated) throw new Error('sandbox sync step output was truncated');
    return result.stdout;
  }
  async function remoteListing(): Promise<Listing> {
    return JSON.parse(await run(`mkdir -p "$1" && python3 -c "$2" "$1"`, [remoteDir, PY_LIST])) as Listing;
  }
  /** Upload a bundle through a scratch file, `ARGS_PER_EXEC` chunks at a time. */
  async function sendBundle(bundle: { files: Array<{ p: string; d: string; m: number }>; delete: string[] }): Promise<void> {
    const encoded = gzipSync(Buffer.from(JSON.stringify(bundle))).toString('base64');
    const blob = `${scratch}-push`;
    await run(`rm -f "$1"`, [blob]);
    for (let offset = 0; offset < encoded.length; offset += ARG_CHUNK_CHARS * ARGS_PER_EXEC) {
      const chunks: string[] = [];
      for (let index = 0; index < ARGS_PER_EXEC; index += 1) {
        const start = offset + index * ARG_CHUNK_CHARS;
        if (start >= encoded.length) break;
        chunks.push(encoded.slice(start, start + ARG_CHUNK_CHARS));
      }
      await run(`out="$1"; shift; for c in "$@"; do printf %s "$c" >> "$out"; done`, [blob, ...chunks]);
    }
    await run(`python3 -c "$1" "$2" "$3"`, [PY_UNPACK, remoteDir, blob]);
  }
  async function receiveFiles(rels: string[]): Promise<Array<{ p: string; d: string; m: number }>> {
    if (rels.length === 0) return [];
    const blob = `${scratch}-pull`;
    const size = Number((await run(`python3 -c "$1" "$2" "$3" "$4"`, [PY_PACK, remoteDir, blob, JSON.stringify(rels)])).trim());
    let encoded = '';
    for (let offset = 0; offset < size; offset += OUTPUT_CHUNK_CHARS) {
      encoded += await run(`tail -c +$(( $2 + 1 )) "$1" | head -c $3`, [blob, String(offset), String(OUTPUT_CHUNK_CHARS)]);
    }
    await run(`rm -f "$1"`, [blob]);
    return JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8')) as Array<{ p: string; d: string; m: number }>;
  }

  /** Returns the sandbox copy as it now stands: the baseline pull() diffs against. */
  async function push(): Promise<Listing> {
    const [all, remote] = await Promise.all([localListing(projectDir), remoteListing()]);
    // Oversized files stay local only; leaving them out of the baseline keeps
    // pull() from reading their absence in the sandbox as a deletion.
    const local: Listing = Object.fromEntries(Object.entries(all).filter(([, entry]) => entry[0] <= MAX_SYNC_FILE_BYTES));
    const changed = Object.keys(local).filter((rel) => !sameEntry(local[rel], remote[rel]));
    // An oversized sandbox file was never copied back, so its local absence is
    // not a deletion either.
    const deleted = Object.keys(remote).filter((rel) => !(rel in all) && remote[rel]![0] <= MAX_SYNC_FILE_BYTES);
    if (changed.length > 0 || deleted.length > 0) {
      const files = await Promise.all(changed.map(async (rel) => ({
        p: rel,
        d: (await fs.readFile(path.join(projectDir, rel))).toString('base64'),
        m: local[rel]![1],
      })));
      await sendBundle({ files, delete: deleted });
    }
    return local;
  }

  async function pull(before: Listing): Promise<{ changed: number; deleted: number; skipped: string[] }> {
    const after = await remoteListing();
    const skipped: string[] = [];
    const changed = Object.keys(after).filter((rel) => {
      if (sameEntry(after[rel], before[rel])) return false;
      if (after[rel]![0] > MAX_SYNC_FILE_BYTES) {
        skipped.push(rel);
        return false;
      }
      return true;
    });
    const deleted = Object.keys(before).filter((rel) => !(rel in after));
    for (const file of await receiveFiles(changed)) {
      const target = await resolveInsideProject(projectDir, file.p);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(file.d, 'base64'));
      const mtime = new Date(file.m);
      await fs.utimes(target, mtime, mtime);
    }
    for (const rel of deleted) {
      await fs.rm(await resolveInsideProject(projectDir, rel), { force: true });
    }
    return { changed: changed.length, deleted: deleted.length, skipped };
  }

  return {
    async execute(input: Record<string, unknown>): Promise<HarnessToolResult> {
      const command = typeof input.command === 'string' ? input.command : '';
      if (command.trim() === '') return { content: 'Error: command must be a non-empty string', isError: true };
      const timeoutMs = Math.min(
        MAX_COMMAND_TIMEOUT_MS,
        Math.max(1_000, typeof input.timeout === 'number' && Number.isFinite(input.timeout) ? input.timeout : DEFAULT_COMMAND_TIMEOUT_MS),
      );
      try {
        await client.ensureRunning();
        const before = await push();
        const result = await client.exec(`cd "$1" && eval "$2"`, [remoteDir, command], timeoutMs);
        const synced = await pull(before);
        return { content: formatResult(result, synced, timeoutMs), isError: result.status !== 'EXECUTE_COMMAND_STATUS_COMPLETED' || result.exitCode !== 0 };
      } catch (error) {
        return { content: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    },
  };
}

function sameEntry(a: [number, number] | undefined, b: [number, number] | undefined): boolean {
  return Boolean(a && b && a[0] === b[0] && a[1] === b[1]);
}

async function localListing(projectDir: string): Promise<Listing> {
  const out: Listing = {};
  const skip = new Set(SANDBOX_SYNC_EXCLUDED_DIRS);
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) await walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        const stat = await fs.stat(path.join(dir, entry.name));
        out[rel] = [stat.size, Math.trunc(stat.mtimeMs)];
      }
    }
  }
  await walk(projectDir, '');
  return out;
}

function formatResult(
  result: SandboxExecResult,
  synced: { changed: number; deleted: number; skipped: string[] },
  timeoutMs: number,
): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout.trimEnd());
  if (result.stderr) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
  if (result.truncated) parts.push('[output truncated]');
  if (result.status === 'EXECUTE_COMMAND_STATUS_TIMED_OUT') parts.push(`[timed out after ${timeoutMs} ms]`);
  else if (result.status !== 'EXECUTE_COMMAND_STATUS_COMPLETED') parts.push(`[command failed to run: ${result.status}]`);
  else if (result.exitCode !== 0) parts.push(`[exit code ${result.exitCode ?? 'unknown'}]`);
  if (synced.changed > 0 || synced.deleted > 0) {
    parts.push(`[project: ${synced.changed} file(s) created or changed, ${synced.deleted} deleted]`);
  }
  if (synced.skipped.length > 0) {
    parts.push(`[not copied back, over ${MAX_SYNC_FILE_BYTES / 1024 / 1024} MB: ${synced.skipped.join(', ')}]`);
  }
  const text = parts.join('\n') || '(no output)';
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text;
}

/** The user's sandbox shell for this run, or null when sandboxes are off or unavailable to them. */
export async function sandboxShellFromEnv(
  env: NodeJS.ProcessEnv,
  host: string,
  token: string,
  projectDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReturnType<typeof createSandboxShell> | null> {
  if ((env.OD_DATABRICKS_SANDBOX ?? '').trim() !== '1') return null;
  const userId = (env.OD_DATABRICKS_USER_ID ?? '').trim();
  if (userId === '') return null;
  try {
    const client = createSandboxClient({ host, token, sandboxId: sandboxIdForUser(userId), fetchImpl });
    await client.probe();
    return createSandboxShell({ client, projectDir });
  } catch (error) {
    process.stderr.write(`[databricks-harness] sandbox unavailable, continuing without Bash: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
}
