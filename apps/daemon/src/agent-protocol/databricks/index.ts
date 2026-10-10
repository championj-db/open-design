/** @module agent-protocol/databricks
 * In-process agent harness on Databricks Model Serving: no spawned CLI, no
 * external model login. `server.ts` wires `attachDatabricksAgentSession` into
 * the chat-run stream switch under `streamFormat: 'databricks'`.
 */
import { databricksHostOrigin } from '../../auth/databricks-obo.js';
import {
  DatabricksServingError,
  createDatabricksServingClient,
  resolveServingCredential,
  resolveServingEndpoint,
  servicePrincipalFromEnv,
  type FetchLike,
  type ServingCredentialSource,
} from '../../integrations/databricks-serving.js';
import { createRunExecutor, type AgentExecutor } from './executor.js';
import { runDatabricksAgent, type DatabricksAgentRunResult, type DatabricksHarnessEvent } from './harness.js';
import type { InProcessAgentChild } from './in-process-child.js';
import { BUILTIN_AGENT_TOOLS } from './tools.js';

export { createInProcessAgentChild, type InProcessAgentChild } from './in-process-child.js';
export { runDatabricksAgent, DATABRICKS_AGENT_SYSTEM_PROMPT } from './harness.js';
export { createLocalExecutor, createRunExecutor, type AgentExecutor } from './executor.js';
export { BUILTIN_AGENT_TOOLS, CODE_EXECUTION_SANDBOX_REQUIRED_MESSAGE } from './tools.js';

export const DATABRICKS_STREAM_FORMAT = 'databricks';

// The OBO token of the user who started a run, held in memory only for the
// run's lifetime so retries (which run outside the original request scope)
// still call Model Serving as that user. Keyed weakly by the run object so it
// is dropped with the run and never reaches persistence or logs.
const runUserTokens = new WeakMap<object, string>();

export function bindRunUserToken(run: object, token: string | null | undefined): void {
  if (token && token.trim()) runUserTokens.set(run, token.trim());
}

export function runUserToken(run: object): string | null {
  return runUserTokens.get(run) ?? null;
}

export interface AttachDatabricksAgentSessionOptions {
  child: InProcessAgentChild;
  prompt: string;
  cwd: string;
  /**
   * Serving endpoint name; null / 'default' uses `OD_DATABRICKS_SERVING_ENDPOINT`,
   * else the first READY chat endpoint discovered for the caller.
   */
  model: string | null;
  /** Daemon env: Databricks host / service-principal config. Never reaches tools. */
  env?: NodeJS.ProcessEnv;
  userToken: string | null;
  emit: (event: DatabricksHarnessEvent) => void;
  /** Called with the auth source in use (never the token), once per change. */
  onCredentialSource?: (source: ServingCredentialSource | null) => void;
  fetch?: FetchLike;
  executor?: AgentExecutor;
}

/**
 * Run the Databricks agent behind `child`, finishing it with exit code 0 on
 * success and 1 on failure (or the kill signal when canceled).
 */
export function attachDatabricksAgentSession(
  options: AttachDatabricksAgentSessionOptions,
): Promise<DatabricksAgentRunResult> {
  const env = options.env ?? process.env;
  let reportedSource: ServingCredentialSource | null | undefined;
  const client = createDatabricksServingClient({
    hostOrigin: databricksHostOrigin(env),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    getCredential: async () => {
      const credential = await resolveServingCredential({
        userToken: options.userToken,
        env,
        servicePrincipal: servicePrincipalFromEnv(env, options.fetch),
      });
      const source = credential?.source ?? null;
      if (source !== reportedSource) {
        reportedSource = source;
        options.onCredentialSource?.(source);
      }
      return credential;
    },
  });
  // File tools are confined to the project cwd and there is no local code
  // execution, so no env (and no daemon credential) is handed to the executor.
  const executor = options.executor ?? createRunExecutor({ cwd: options.cwd });
  const run = async (): Promise<DatabricksAgentRunResult> => {
    let endpoint: string;
    try {
      endpoint = await resolveServingEndpoint({
        model: options.model,
        env,
        client,
        signal: options.child.abortSignal,
      });
    } catch (err) {
      if (options.child.abortSignal.aborted) return { status: 'canceled', turns: 0, usage: {} };
      const code = err instanceof DatabricksServingError ? err.code : 'DATABRICKS_AGENT_FAILED';
      const message = (err as Error)?.message ?? String(err);
      options.emit({ type: 'error', message, code });
      return { status: 'failed', turns: 0, usage: {}, error: { code, message } };
    }
    return runDatabricksAgent({
      client,
      endpoint,
      prompt: options.prompt,
      tools: BUILTIN_AGENT_TOOLS,
      executor,
      emit: options.emit,
      signal: options.child.abortSignal,
    });
  };
  return run().then(
    (result) => {
      if (result.status === 'canceled') options.child.finish(null, 'SIGTERM');
      else options.child.finish(result.status === 'succeeded' ? 0 : 1);
      return result;
    },
    (err) => {
      options.emit({ type: 'error', message: (err as Error)?.message ?? String(err) });
      options.child.finish(1);
      return { status: 'failed', turns: 0, usage: {} } as DatabricksAgentRunResult;
    },
  );
}


export interface DatabricksConnectionTestResult {
  ok: boolean;
  kind:
    | 'success'
    | 'auth_failed'
    | 'forbidden'
    | 'not_found_model'
    | 'rate_limited'
    | 'upstream_unavailable'
    | 'agent_auth_required'
    | 'unknown';
  latencyMs: number;
  model: string;
  agentName: string;
  sample?: string;
  status?: number;
  detail?: string;
}

/** Settings "Test connection" for the Databricks agent: one short, tool-less serving call. */
export async function testDatabricksAgentConnection(options: {
  agentName: string;
  model: string | null;
  userToken: string | null;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  fetch?: FetchLike;
}): Promise<DatabricksConnectionTestResult> {
  const env = options.env ?? process.env;
  const startedAt = Date.now();
  let endpoint = options.model?.trim() || 'default';
  const base = () => ({ model: endpoint, agentName: options.agentName });
  const client = createDatabricksServingClient({
    hostOrigin: databricksHostOrigin(env),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    getCredential: () =>
      resolveServingCredential({
        userToken: options.userToken,
        env,
        servicePrincipal: servicePrincipalFromEnv(env, options.fetch),
      }),
  });
  try {
    endpoint = await resolveServingEndpoint({ model: options.model, env, client, ...(options.signal ? { signal: options.signal } : {}) });
    let sample = '';
    for await (const event of client.streamChat({
      endpoint,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      maxTokens: 16,
      signal: options.signal ?? AbortSignal.timeout(30_000),
    })) {
      if (event.type === 'text') sample += event.delta;
    }
    return { ...base(), ok: true, kind: 'success', latencyMs: Date.now() - startedAt, sample: sample.slice(0, 120) };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const detail = (err as Error)?.message ?? String(err);
    if (err instanceof DatabricksServingError) {
      if (err.code === 'DATABRICKS_SERVING_CONFIG') {
        return { ...base(), ok: false, kind: 'not_found_model', latencyMs, detail };
      }
      if (err.code === 'DATABRICKS_AUTH_REQUIRED' || err.code === 'DATABRICKS_HOST_MISSING') {
        return { ...base(), ok: false, kind: 'agent_auth_required', latencyMs, detail };
      }
      const status = err.status;
      const kind = status === 401
        ? 'auth_failed'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'not_found_model'
            : status === 429
              ? 'rate_limited'
              : 'upstream_unavailable';
      return { ...base(), ok: false, kind, latencyMs, detail, ...(status ? { status } : {}) };
    }
    return { ...base(), ok: false, kind: 'unknown', latencyMs, detail };
  }
}
