import { databricksHostOrigin } from '../../auth/databricks-obo.js';
import { getCurrentUserAccessToken } from '../../auth/current-user.js';
import {
  createDatabricksServingClient,
  configuredServingEndpoint,
  readyChatEndpoints,
  resolveServingCredential,
  servicePrincipalFromEnv,
} from '../../integrations/databricks-serving.js';
import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef, RuntimeModelOption } from '../types.js';

export const DATABRICKS_AGENT_ID = 'databricks';

function defaultEndpointOption(env: NodeJS.ProcessEnv): RuntimeModelOption {
  const configured = configuredServingEndpoint(env);
  return configured ? { ...DEFAULT_MODEL_OPTION, label: `Default (${configured})` } : DEFAULT_MODEL_OPTION;
}

// Only READY chat endpoints are selectable: a not-ready endpoint cannot
// answer a run, so listing it would only offer a guaranteed failure.
export function servingEndpointModels(
  endpoints: Array<{ name: string; task: string | null; ready: boolean }>,
  env: NodeJS.ProcessEnv,
): RuntimeModelOption[] {
  return [
    defaultEndpointOption(env),
    ...readyChatEndpoints(endpoints).map((endpoint) => ({ id: endpoint.name, label: endpoint.name })),
  ];
}

export const databricksAgentDef = {
  id: DATABRICKS_AGENT_ID,
  name: 'Databricks Agent',
  // Label only: the agent runs in-process (see `inProcess`).
  bin: 'databricks-model-serving',
  inProcess: true,
  versionArgs: [],
  fallbackModels: [DEFAULT_MODEL_OPTION],
  buildArgs: () => [],
  streamFormat: 'databricks',
  // The model id is a serving endpoint name, which workspaces name freely.
  supportsCustomModel: true,
  // Discover endpoints as the requesting user when the call happens inside a
  // request scope (GET /api/agents), else as the app service principal.
  fetchModels: async (_resolvedBin, env) => {
    const hostOrigin = databricksHostOrigin(env);
    if (!hostOrigin) return null;
    const client = createDatabricksServingClient({
      hostOrigin,
      getCredential: () =>
        resolveServingCredential({
          userToken: getCurrentUserAccessToken(),
          env,
          servicePrincipal: servicePrincipalFromEnv(env),
        }),
    });
    try {
      return servingEndpointModels(await client.listEndpoints(), env);
    } catch {
      return null;
    }
  },
} satisfies RuntimeAgentDef;
