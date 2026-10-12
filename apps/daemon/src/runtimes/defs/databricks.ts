import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

// The workspace's Model Serving models, driven by OpenDesign's own harness
// (databricks/agent-harness.ts) as the signed-in user. Registered only in
// Databricks auth mode (see registry.ts): the run needs that user's
// on-behalf-of token, which the daemon injects per run.
//
// The "binary" is the daemon's own Node with the harness shipped beside this
// module, so no external CLI is installed or spawned.
export const DATABRICKS_AGENT_ID = 'databricks';

function harnessEntry(): string {
  // Built daemon: dist/databricks/ sits beside dist/runtimes/. Running the
  // daemon from source (tsx, tests), use the built harness in dist/ instead,
  // since plain Node cannot resolve the source tree's `.js` import specifiers.
  const sibling = fileURLToPath(new URL('../../databricks/agent-harness.js', import.meta.url));
  const fromSource = fileURLToPath(new URL('../../../dist/databricks/agent-harness.js', import.meta.url));
  return existsSync(sibling) ? sibling : fromSource;
}

export const databricksAgentDef = {
  id: DATABRICKS_AGENT_ID,
  name: 'Databricks',
  bin: 'node',
  fallbackBins: [process.execPath],
  versionArgs: ['--version'],
  fallbackModels: [DEFAULT_MODEL_OPTION],
  buildArgs: (_prompt, imagePaths, _extraAllowedDirs, options = {}) => {
    const args = [harnessEntry()];
    if (options.model && options.model !== 'default') args.push('--model', options.model);
    for (const imagePath of imagePaths) args.push('--image', imagePath);
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'claude-stream-json',
  supportsCustomModel: true,
} satisfies RuntimeAgentDef;
