/** @module agent-protocol/databricks
 * In-process agent harness on Databricks Model Serving: no spawned CLI, no
 * external model login. `server.ts` wires `attachDatabricksAgentSession` into
 * the chat-run stream switch under `streamFormat: 'databricks'`.
 */
import { databricksHostOrigin } from '../../auth/databricks-obo.js';
import {
  createDatabricksServingClient,
  defaultServingEndpoint,
  resolveServingCredential,
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
export { BUILTIN_AGENT_TOOLS } from './tools.js';

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
  /** Serving endpoint name; null / 'default' uses `OD_DATABRICKS_SERVING_ENDPOINT`. */
  model: string | null;
  readableRoots?: string[];
  /** Daemon env: Databricks host / service-principal config. */
  env?: NodeJS.ProcessEnv;
  /** Env for tool commands (the run's agent env). Databricks secrets are stripped. */
  executorEnv?: NodeJS.ProcessEnv;
  userToken: string | null;
  emit: (event: DatabricksHarnessEvent) => void;
  /** Called once with the auth source actually used (never the token). */
  onCredentialSource?: (source: ServingCredentialSource | null) => void;
  fetch?: FetchLike;
  executor?: AgentExecutor;
}

export function resolveServingEndpointForModel(model: string | null, env: NodeJS.ProcessEnv): string {
  const trimmed = model?.trim();
  return trimmed && trimmed !== 'default' ? trimmed : defaultServingEndpoint(env);
}

// Model-driven shell commands must never see the credentials the daemon uses
// to call Model Serving.
const DATABRICKS_SECRET_ENV_KEYS = ['DATABRICKS_TOKEN', 'DATABRICKS_CLIENT_SECRET', 'DATABRICKS_CLIENT_ID'];

function withoutDatabricksSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of DATABRICKS_SECRET_ENV_KEYS) delete out[key];
  return out;
}

/**
 * Run the Databricks agent behind `child`, finishing it with exit code 0 on
 * success and 1 on failure (or the kill signal when canceled).
 */
export function attachDatabricksAgentSession(
  options: AttachDatabricksAgentSessionOptions,
): Promise<DatabricksAgentRunResult> {
  const env = options.env ?? process.env;
  const client = createDatabricksServingClient({
    hostOrigin: databricksHostOrigin(env),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    getCredential: async () => {
      const credential = await resolveServingCredential({
        userToken: options.userToken,
        env,
        servicePrincipal: servicePrincipalFromEnv(env, options.fetch),
      });
      options.onCredentialSource?.(credential?.source ?? null);
      return credential;
    },
  });
  const executor = options.executor ?? createRunExecutor({
    cwd: options.cwd,
    ...(options.readableRoots ? { readableRoots: options.readableRoots } : {}),
    env: withoutDatabricksSecrets(options.executorEnv ?? env),
  });
  return runDatabricksAgent({
    client,
    endpoint: resolveServingEndpointForModel(options.model, env),
    prompt: options.prompt,
    tools: BUILTIN_AGENT_TOOLS,
    executor,
    emit: options.emit,
    signal: options.child.abortSignal,
  }).then(
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

