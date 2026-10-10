// Where the in-process Databricks agent's tools actually run.
//
// Every tool the harness exposes reaches the outside world through an
// `AgentExecutor`, never through `fs` / `child_process` directly. Today the
// only implementation is `createLocalExecutor`, which works against the
// project directory inside the daemon's own container. The seam exists so a
// Databricks-hosted sandbox can take over command execution (and, later, the
// file operations) without the harness or the tool definitions changing.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ExecutorCommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecutorDirEntry {
  name: string;
  kind: 'file' | 'directory' | 'other';
}

export interface AgentExecutor {
  /** Human-readable label surfaced in status events and diagnostics. */
  readonly kind: string;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  listDir(relativePath: string): Promise<ExecutorDirEntry[]>;
  runCommand(
    command: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ExecutorCommandResult>;
}

export class ExecutorPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorPathError';
  }
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;

export interface LocalExecutorOptions {
  /** Project root; every path a tool names is resolved inside it. */
  cwd: string;
  /** Extra read-only roots (skills, design systems) the prompt may cite. */
  readableRoots?: string[];
  env?: NodeJS.ProcessEnv;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Executes tools in-container against the project cwd.
 *
 * Paths are resolved relative to `cwd` and must stay inside it (reads may also
 * target `readableRoots`). Symlinks are resolved before the check so a link
 * cannot smuggle a write outside the project.
 */
export function createLocalExecutor(options: LocalExecutorOptions): AgentExecutor {
  const root = path.resolve(options.cwd);
  const readableRoots = [root, ...(options.readableRoots ?? []).map((dir) => path.resolve(dir))];

  async function realpathOrSelf(target: string): Promise<string> {
    try {
      return await fs.realpath(target);
    } catch {
      // A not-yet-existing file: check its nearest existing ancestor instead.
      const parent = path.dirname(target);
      if (parent === target) return target;
      return path.join(await realpathOrSelf(parent), path.basename(target));
    }
  }

  async function resolveInside(relativePath: string, roots: string[]): Promise<string> {
    if (typeof relativePath !== 'string' || !relativePath.trim()) {
      throw new ExecutorPathError('A path is required');
    }
    const resolved = path.resolve(root, relativePath);
    const real = await realpathOrSelf(resolved);
    for (const allowed of roots) {
      const realAllowed = await realpathOrSelf(allowed);
      if (isInside(allowed, resolved) && isInside(realAllowed, real)) return resolved;
    }
    throw new ExecutorPathError(`Path is outside the project directory: ${relativePath}`);
  }

  return {
    kind: 'local',
    async readFile(relativePath) {
      return fs.readFile(await resolveInside(relativePath, readableRoots), 'utf8');
    },
    async writeFile(relativePath, content) {
      const target = await resolveInside(relativePath, [root]);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    },
    async listDir(relativePath) {
      const target = await resolveInside(relativePath || '.', readableRoots);
      const entries = await fs.readdir(target, { withFileTypes: true });
      return entries
        .map((entry): ExecutorDirEntry => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    // TODO(sandbox-wave): route this through a Databricks sandbox executor
    // (remote, per-user, UC-governed) instead of a local shell. Implement
    // `AgentExecutor` for the sandbox and select it in `createRunExecutor`
    // below; the harness and tool specs need no changes.
    runCommand(command, runOptions = {}) {
      const timeoutMs = Math.min(
        Math.max(1, runOptions.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
        MAX_COMMAND_TIMEOUT_MS,
      );
      return new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', command], {
          cwd: root,
          env: options.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const capture = (current: string, chunk: Buffer) =>
          current.length >= MAX_CAPTURED_OUTPUT_BYTES
            ? current
            : (current + chunk.toString('utf8')).slice(0, MAX_CAPTURED_OUTPUT_BYTES);
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout = capture(stdout, chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = capture(stderr, chunk);
        });
        const kill = () => {
          try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            // already gone
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeoutMs);
        const onAbort = () => kill();
        runOptions.signal?.addEventListener('abort', onAbort, { once: true });
        const finish = (exitCode: number | null, signal: string | null) => {
          clearTimeout(timer);
          runOptions.signal?.removeEventListener('abort', onAbort);
          resolve({ exitCode, signal, stdout, stderr, timedOut });
        };
        child.on('error', (err) => {
          stderr += `${stderr ? '\n' : ''}${err.message}`;
          finish(null, null);
        });
        child.on('close', (code, signal) => finish(code, signal));
      });
    },
  };
}

export interface RunExecutorOptions extends LocalExecutorOptions {}

/**
 * The executor a chat run uses. Local today.
 *
 * TODO(sandbox-wave): return the Databricks sandbox executor here once it
 * exists (e.g. when `OD_DATABRICKS_SANDBOX` is configured).
 */
export function createRunExecutor(options: RunExecutorOptions): AgentExecutor {
  return createLocalExecutor(options);
}
