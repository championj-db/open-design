import { databricksFetch, type DatabricksCaller } from './client.js';
import type { DatabricksRuntime } from './runtime.js';

// The chat models a user may run: the workspace's Model Serving endpoints
// with task `llm/v1/chat` that are ready, listed with that user's own token so
// endpoint ACLs decide what they see. Discovered per request rather than
// hard-coded, because the catalogue differs by workspace and changes often.

// Used when the user leaves the model on "default". Overridable per deployment
// with OD_DATABRICKS_DEFAULT_MODEL, since the catalogue differs by workspace.
export const DATABRICKS_FALLBACK_CHAT_MODEL = 'databricks-claude-sonnet-4-5';

export function resolveDatabricksChatModel(
  requested: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = (requested ?? '').trim();
  if (explicit !== '' && explicit !== 'default') return explicit;
  return (env.OD_DATABRICKS_DEFAULT_MODEL ?? '').trim() || DATABRICKS_FALLBACK_CHAT_MODEL;
}

export interface DatabricksChatEndpoint {
  /** Endpoint name; this is the `model` sent to `/serving-endpoints/chat/completions`. */
  name: string;
  /** The served foundation model's display name when there is one, else the endpoint name. */
  displayName: string;
}

export function chatEndpointsFromList(body: unknown): DatabricksChatEndpoint[] {
  const endpoints = isRecord(body) && Array.isArray(body.endpoints) ? body.endpoints : [];
  return endpoints
    .filter(isRecord)
    .filter((endpoint) => endpoint.task === 'llm/v1/chat')
    .filter((endpoint) => isRecord(endpoint.state) && endpoint.state.ready === 'READY')
    .flatMap((endpoint) => {
      const name = typeof endpoint.name === 'string' ? endpoint.name.trim() : '';
      if (name === '') return [];
      const config = isRecord(endpoint.config) ? endpoint.config : {};
      const entities = Array.isArray(config.served_entities) ? config.served_entities.filter(isRecord) : [];
      const displayName = entities
        .map((entity) => (isRecord(entity.foundation_model) ? entity.foundation_model.display_name : null))
        .find((value): value is string => typeof value === 'string' && value.trim() !== '');
      return [{ name, displayName: displayName?.trim() ?? name }];
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function listChatEndpoints(
  runtime: DatabricksRuntime,
  caller: DatabricksCaller,
  fetchImpl: typeof fetch = fetch,
): Promise<DatabricksChatEndpoint[]> {
  const response = await databricksFetch(runtime, caller, '/api/2.0/serving-endpoints', {}, fetchImpl);
  if (!response.ok) {
    throw new Error(`Listing serving endpoints returned HTTP ${response.status}`);
  }
  return chatEndpointsFromList(await response.json());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
