import { randomBytes } from 'node:crypto';

import type { Express, Request, Response as ExpressResponse } from 'express';

import type { ToolTokenGrant } from '../tool-tokens.js';
import {
  SANDBOX_EXEC_TOOL_ENDPOINT,
  SANDBOX_EXEC_TOOL_OPERATION,
  SandboxUnavailableError,
  type SandboxExecResult,
} from './sandbox.js';

// The daemon side of the Databricks agent's Bash tool. Sandboxes are created
// and driven by the app's service principal — Databricks Apps offers no
// "sandbox" user API scope — so this broker, not the agent, holds that
// identity: the agent harness reaches it through a run-scoped tool token
// (`/api/tools/databricks/sandbox/exec`), and the service principal's
// credentials never leave the daemon.
//
// Sandboxes are ephemeral: one per user conversation, created on its first
// command under a random name, and deleted once it has been idle for
// `idleMs`, when the daemon shuts down, and — for any a crashed daemon left
// behind — when the next daemon starts. Nothing in a sandbox is kept: the
// project files the agent works on live in the daemon data root (mirrored to
// the UC volume) and are copied in and back around each command (sandbox.ts).

/** Every sandbox this app creates is named with this prefix, so a startup sweep can find leftovers. */
export const SESSION_SANDBOX_PREFIX = 'od-session-';
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const START_TIMEOUT_MS = 180_000;
// Databricks stops a sandbox nobody uses; the broker deletes it well before.
const INACTIVITY_TIMEOUT_SECONDS = 1800;

type Log = Pick<Console, 'info' | 'warn'>;

export interface SandboxApi {
  /** null when the sandbox does not exist. */
  state(sandboxId: string): Promise<string | null>;
  create(sandboxId: string, displayName: string): Promise<void>;
  start(sandboxId: string): Promise<void>;
  remove(sandboxId: string): Promise<void>;
  /** Ids of the sandboxes this identity owns. */
  list(): Promise<string[]>;
  exec(sandboxId: string, script: string, args: string[], timeoutMs: number): Promise<SandboxExecResult>;
}

export function createSandboxApi({
  host,
  getToken,
  fetchImpl = fetch,
}: {
  host: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): SandboxApi {
  const base = host.replace(/\/+$/, '');
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await getToken()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function fail(response: Response, action: string): Promise<never> {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    if (response.status === 401 || response.status === 403) {
      throw new SandboxUnavailableError(
        `Databricks refused to ${action} (HTTP ${response.status}). The app's service principal needs access to `
        + `Databricks Sandbox, and the workspace needs the Sandbox preview. ${detail}`.trim(),
      );
    }
    throw new SandboxUnavailableError(`Could not ${action}: HTTP ${response.status}. ${detail}`.trim());
  }
  return {
    async state(sandboxId) {
      const response = await call('GET', `/api/2.0/sandboxes/${encodeURIComponent(sandboxId)}`);
      if (response.status === 404) return null;
      if (!response.ok) return fail(response, 'read a sandbox');
      const body = (await response.json().catch(() => null)) as { status?: { state?: unknown } } | null;
      return typeof body?.status?.state === 'string' ? body.status.state : 'SANDBOX_STATE_UNSPECIFIED';
    },
    async create(sandboxId, displayName) {
      const response = await call('POST', `/api/2.0/sandboxes?sandbox_id=${encodeURIComponent(sandboxId)}`, {
        display_name: displayName,
        spec: {
          compute: { inactivity_timeout: `${INACTIVITY_TIMEOUT_SECONDS}s` },
          // Commands come from a model; the sandbox must not carry the
          // service principal's Databricks credentials.
          identity: { databricks_access_token_included: false },
        },
      });
      if (!response.ok && response.status !== 409) await fail(response, 'create a sandbox');
    },
    async start(sandboxId) {
      const response = await call('POST', `/api/2.0/sandboxes/${encodeURIComponent(sandboxId)}/start`);
      if (!response.ok && response.status !== 409) await fail(response, 'start a sandbox');
    },
    async remove(sandboxId) {
      const response = await call('DELETE', `/api/2.0/sandboxes/${encodeURIComponent(sandboxId)}`);
      if (!response.ok && response.status !== 404) await fail(response, 'delete a sandbox');
    },
    async list() {
      const ids: string[] = [];
      let pageToken = '';
      do {
        const response = await call('GET', `/api/2.0/sandboxes${pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : ''}`);
        if (!response.ok) return fail(response, 'list sandboxes');
        const body = (await response.json().catch(() => null)) as { sandboxes?: Array<{ name?: unknown }>; next_page_token?: unknown } | null;
        for (const entry of body?.sandboxes ?? []) {
          if (typeof entry.name === 'string') ids.push(entry.name.replace(/^sandboxes\//, ''));
        }
        pageToken = typeof body?.next_page_token === 'string' ? body.next_page_token : '';
      } while (pageToken);
      return ids;
    },
    async exec(sandboxId, script, args, timeoutMs) {
      const response = await call('POST', `/api/2.0/sandbox-exec/sandboxes/${encodeURIComponent(sandboxId)}/exec-sync`, {
        cmd: '/bin/bash',
        args: ['-c', script, 'od', ...args],
        execution_timeout: `${Math.ceil(timeoutMs / 1000)}s`,
      });
      if (!response.ok) return fail(response, 'run a command in the sandbox');
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

export interface SandboxSessionKey {
  userId: string;
  conversationId: string;
}

interface Session {
  sandboxId: string;
  ready: Promise<void>;
  lastUsed: number;
  busy: number;
}

export interface SandboxBroker {
  /** Delete sandboxes a previous daemon left behind; false when the service principal cannot use sandboxes. */
  init(): Promise<boolean>;
  exec(key: SandboxSessionKey, script: string, args: string[], timeoutMs: number): Promise<SandboxExecResult>;
  /** Delete sandboxes idle for longer than the idle window. */
  sweep(): Promise<void>;
  /** Delete every session sandbox. */
  stop(): Promise<void>;
  readonly sessionCount: number;
}

export function createSandboxBroker({
  api,
  idleMs = DEFAULT_IDLE_MS,
  now = Date.now,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  newSandboxId = () => `${SESSION_SANDBOX_PREFIX}${randomBytes(8).toString('hex')}`,
  log = console,
}: {
  api: SandboxApi;
  idleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  newSandboxId?: () => string;
  log?: Log;
}): SandboxBroker {
  const sessions = new Map<string, Session>();
  let timer: NodeJS.Timeout | null = null;

  async function waitUntilRunning(sandboxId: string): Promise<void> {
    const deadline = now() + START_TIMEOUT_MS;
    let current = await api.state(sandboxId);
    while (current !== 'SANDBOX_STATE_RUNNING') {
      if (current === null) throw new SandboxUnavailableError('The sandbox for this conversation disappeared. Try again.');
      if (current === 'SANDBOX_STATE_STOPPED') await api.start(sandboxId);
      if (now() > deadline) throw new SandboxUnavailableError('The sandbox did not start within 3 minutes. Try again.');
      await sleep(2_000);
      current = await api.state(sandboxId);
    }
  }

  function session(key: SandboxSessionKey): Session {
    const id = `${key.userId}\n${key.conversationId}`;
    const existing = sessions.get(id);
    if (existing) return existing;
    const sandboxId = newSandboxId();
    const created: Session = {
      sandboxId,
      lastUsed: now(),
      busy: 0,
      ready: api.create(sandboxId, `OpenDesign session (user ${key.userId})`).then(() => waitUntilRunning(sandboxId)),
    };
    // A failed create must not pin the conversation to a broken sandbox.
    created.ready.catch(() => {
      if (sessions.get(id) === created) sessions.delete(id);
      void api.remove(sandboxId).catch(() => {});
    });
    sessions.set(id, created);
    log.info(`[databricks-sandbox] created ${sandboxId} for user ${key.userId}`);
    return created;
  }

  async function remove(id: string, entry: Session): Promise<void> {
    sessions.delete(id);
    try {
      await api.remove(entry.sandboxId);
      log.info(`[databricks-sandbox] deleted ${entry.sandboxId}`);
    } catch (error) {
      log.warn(`[databricks-sandbox] could not delete ${entry.sandboxId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    get sessionCount() {
      return sessions.size;
    },
    async init() {
      let leftovers: string[];
      try {
        leftovers = (await api.list()).filter((id) => id.startsWith(SESSION_SANDBOX_PREFIX));
      } catch (error) {
        log.warn(`[databricks-sandbox] sandboxes unavailable, the agent keeps file tools only: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      await Promise.all(leftovers.map((id) => api.remove(id).catch(() => {})));
      if (leftovers.length > 0) log.info(`[databricks-sandbox] deleted ${leftovers.length} sandbox(es) left by a previous run`);
      timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
      timer.unref();
      return true;
    },
    async exec(key, script, args, timeoutMs) {
      const entry = session(key);
      entry.busy += 1;
      try {
        await entry.ready;
        try {
          return await api.exec(entry.sandboxId, script, args, timeoutMs);
        } catch (error) {
          // Databricks stops a sandbox it considers idle; bring it back once.
          if ((await api.state(entry.sandboxId).catch(() => null)) !== 'SANDBOX_STATE_STOPPED') throw error;
          await waitUntilRunning(entry.sandboxId);
          return await api.exec(entry.sandboxId, script, args, timeoutMs);
        }
      } finally {
        entry.busy -= 1;
        entry.lastUsed = now();
      }
    },
    async sweep() {
      const cutoff = now() - idleMs;
      await Promise.all(
        [...sessions.entries()]
          .filter(([, entry]) => entry.busy === 0 && entry.lastUsed < cutoff)
          .map(([id, entry]) => remove(id, entry)),
      );
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.all([...sessions.entries()].map(([id, entry]) => remove(id, entry)));
    },
  };
}

/**
 * `POST /api/tools/databricks/sandbox/exec` — the agent harness's only way
 * into a sandbox. The tool token names the run; the run names its user and
 * conversation, which pick the sandbox, so a run can only reach its own.
 */
export function registerSandboxToolRoutes(
  app: Express,
  ctx: {
    broker: SandboxBroker;
    authorizeToolRequest: (req: Request, res: ExpressResponse, operation: string) => ToolTokenGrant | null;
    sessionForRun: (runId: string) => SandboxSessionKey | null;
    sendApiError: (res: ExpressResponse, status: number, code: string, message: string) => void;
  },
): void {
  app.post(SANDBOX_EXEC_TOOL_ENDPOINT, async (req, res) => {
    const grant = ctx.authorizeToolRequest(req, res, SANDBOX_EXEC_TOOL_OPERATION);
    if (!grant) return;
    const key = ctx.sessionForRun(grant.runId);
    if (!key) return ctx.sendApiError(res, 403, 'SANDBOX_SESSION_DENIED', 'this run has no signed-in user or conversation');
    const body = (req.body ?? {}) as { script?: unknown; args?: unknown; timeoutMs?: unknown };
    if (typeof body.script !== 'string' || !Array.isArray(body.args) || !body.args.every((arg) => typeof arg === 'string')) {
      return ctx.sendApiError(res, 400, 'BAD_REQUEST', 'script must be a string and args a string array');
    }
    const timeoutMs = typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs) ? body.timeoutMs : 60_000;
    try {
      res.json(await ctx.broker.exec(key, body.script, body.args as string[], timeoutMs));
    } catch (error) {
      ctx.sendApiError(res, 502, 'SANDBOX_UNAVAILABLE', error instanceof Error ? error.message : String(error));
    }
  });
}
