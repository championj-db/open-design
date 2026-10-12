import { DATABRICKS_AGENT_ID } from '../runtimes/defs/databricks.js';
import type { DetectedAgent } from '../runtimes/types.js';
import { databricksRequestContext } from './request-context.js';
import type { DatabricksRuntime } from './runtime.js';
import { listChatEndpoints, resolveDatabricksChatModel } from './serving-endpoints.js';

/**
 * The Databricks agent's model list is per user: the ready chat endpoints the
 * caller can see, listed with their own token. Agent detection is cached for
 * the whole daemon, so `/api/agents` applies this per request on top of it.
 * Any other agent, or a caller without a user, passes through unchanged; a
 * listing failure keeps the static list (custom model ids still work).
 */
export async function databricksAgentForRequest(
  runtime: DatabricksRuntime,
  agent: DetectedAgent,
  req: object,
  fetchImpl: typeof fetch = fetch,
): Promise<DetectedAgent> {
  if (agent.id !== DATABRICKS_AGENT_ID || !databricksRequestContext(req)) return agent;
  try {
    const endpoints = await listChatEndpoints(runtime, { as: 'user', req }, fetchImpl);
    if (endpoints.length === 0) return agent;
    const defaultModel = resolveDatabricksChatModel(null);
    const defaultLabel = endpoints.find((endpoint) => endpoint.name === defaultModel)?.displayName ?? defaultModel;
    return {
      ...agent,
      models: [
        { id: 'default', label: `Default · ${defaultLabel}` },
        ...endpoints.map((endpoint) => ({ id: endpoint.name, label: endpoint.displayName })),
      ],
      modelsSource: 'live',
    };
  } catch (error) {
    console.warn('[databricks] listing serving endpoints failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return agent;
  }
}
