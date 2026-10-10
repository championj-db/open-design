// Where the in-process Databricks agent's tools actually run.
//
// Every tool the harness exposes reaches the outside world through an
// `AgentExecutor`, never through `fs` / `child_process` directly. Today the
// only implementation is `createLocalExecutor`, which works against the
// project directory inside the daemon's own container. The seam exists so a
// Databricks-hosted sandbox can take over command execution (and, later, the
// file operations) without the harness or the tool definitions changing.
//
// Security posture of the local executor (the model drives every call, so
// treat each one as untrusted input):
//  - File operations are confined to the project directory. Absolute paths
//    outside it, `..` traversal, and symlinks that resolve outside it are
//    refused; the final path component is opened with O_NOFOLLOW.
//  - There is NO local command execution. `runCommand` is absent, so the
//    `Bash` tool reports that code execution needs the Databricks sandbox.
//    The daemon's container privileges, network and environment (other
//    credentials, internal tool tokens) are never handed to model-written
//    shell.
import { constants as fsConstants, promises as fs } from 'node:fs';
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
  /**
   * Run a shell command. Only an isolated executor (the Databricks sandbox)
   * implements this; when it is absent, code execution is unavailable.
   */
  runCommand?(
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

export interface LocalExecutorOptions {
  /** Project root; every path a tool names must resolve inside it. */
  cwd: string;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// O_NOFOLLOW is POSIX-only; on Windows the realpath check alone applies.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * File tools against the project cwd, and nothing else.
 *
 * A path is accepted only when it is lexically inside the project AND its
 * real path (every symlink resolved) is inside the project's real path. Reads
 * open that verified real path and writes open the leaf with O_NOFOLLOW, so a
 * link swapped in after the check is refused rather than followed.
 */
export function createLocalExecutor(options: LocalExecutorOptions): AgentExecutor {
  const root = path.resolve(options.cwd);
  let realRootPromise: Promise<string> | null = null;
  const realRoot = () => (realRootPromise ??= fs.realpath(root));

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

  function outside(requested: string): ExecutorPathError {
    return new ExecutorPathError(`Path is outside the project directory: ${requested}`);
  }

  async function resolveInside(requested: string): Promise<string> {
    if (typeof requested !== 'string' || !requested.trim()) {
      throw new ExecutorPathError('A path is required');
    }
    if (requested.includes('\0')) throw new ExecutorPathError('Path contains a NUL byte');
    const resolved = path.resolve(root, requested);
    if (!isInside(root, resolved)) throw outside(requested);
    if (!isInside(await realRoot(), await realpathOrSelf(resolved))) throw outside(requested);
    return resolved;
  }

  async function openNoFollow(target: string, flags: number, requested: string) {
    try {
      return await fs.open(target, flags | O_NOFOLLOW, 0o644);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ELOOP') {
        throw new ExecutorPathError(`Refusing to follow a symlink: ${requested}`);
      }
      throw err;
    }
  }

  return {
    kind: 'local',
    async readFile(requested) {
      // Open the already-verified real path, so an in-project link still reads.
      const real = await fs.realpath(await resolveInside(requested));
      const handle = await openNoFollow(real, fsConstants.O_RDONLY, requested);
      try {
        return await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    },
    async writeFile(requested, content) {
      const target = await resolveInside(requested);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Re-check now that the parent chain exists: a symlinked ancestor that
      // did not resolve before mkdir must not redirect the write.
      if (!isInside(await realRoot(), await realpathOrSelf(target))) throw outside(requested);
      const handle = await openNoFollow(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
        requested,
      );
      try {
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
    },
    async listDir(requested) {
      const target = await resolveInside(requested || '.');
      const entries = await fs.readdir(await fs.realpath(target), { withFileTypes: true });
      return entries
        .map((entry): ExecutorDirEntry => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    // No `runCommand`: the local executor never runs model-written shell.
  };
}

export interface RunExecutorOptions extends LocalExecutorOptions {}

/**
 * The executor a chat run uses. Local (files only, no code execution) today.
 *
 * TODO(sandbox-wave): return the Databricks sandbox executor here once it
 * exists (e.g. when `OD_DATABRICKS_SANDBOX` is configured). It implements
 * `runCommand` remotely (per-user, UC-governed, with an explicit env
 * allowlist — never the daemon's env), which re-enables the `Bash` tool; the
 * harness and tool specs need no changes.
 */
export function createRunExecutor(options: RunExecutorOptions): AgentExecutor {
  return createLocalExecutor(options);
}
