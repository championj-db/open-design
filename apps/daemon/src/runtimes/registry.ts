import { claudeAgentDef } from './defs/claude.js';
import { codexAgentDef } from './defs/codex.js';
import { devinAgentDef } from './defs/devin.js';
import { opencodeAgentDef } from './defs/opencode.js';
import { byokOpenCodeAgentDef } from './defs/byok-opencode.js';
import { hermesAgentDef } from './defs/hermes.js';
import { traeCliAgentDef } from './defs/trae-cli.js';
import { grokBuildAgentDef } from './defs/grok-build.js';
import { kimiAgentDef } from './defs/kimi.js';
import { cursorAgentDef } from './defs/cursor-agent.js';
import { qwenAgentDef } from './defs/qwen.js';
import { qoderAgentDef } from './defs/qoder.js';
import { copilotAgentDef } from './defs/copilot.js';
import { ampAgentDef } from './defs/amp.js';
import { piAgentDef } from './defs/pi.js';
import { kiroAgentDef } from './defs/kiro.js';
import { kiloAgentDef } from './defs/kilo.js';
import { vibeAgentDef } from './defs/vibe.js';
import { deepseekAgentDef } from './defs/deepseek.js';
import { deepseekHarnessAgentDef } from './defs/deepseek-harness.js';
import { aiderAgentDef } from './defs/aider.js';
import { antigravityAgentDef } from './defs/antigravity.js';
import { codebuddyAgentDef } from './defs/codebuddy.js';
import { reasonixAgentDef } from './defs/reasonix.js';
import { mimoAgentDef } from './defs/mimo.js';
import { atomcodeAgentDef } from './defs/atomcode.js';
import { databricksAgentDef } from './defs/databricks.js';
import { readLocalAgentProfileDefs as readLocalAgentProfileDefsFromFile } from './local-profiles.js';
import type { RuntimeAgentDef } from './types.js';

/**
 * The CLI-spawning runtimes OpenDesign shipped before the Databricks agent.
 *
 * NOT registered: on Databricks the only agent is the in-process Databricks
 * Model Serving harness, so none of these is selectable, detected, or spawned.
 * The def files stay in place for a follow-up strip task that removes them
 * (and their stream parsers) wholesale.
 */
export const UNREGISTERED_CLI_AGENT_DEFS: RuntimeAgentDef[] = [
  claudeAgentDef,
  codexAgentDef,
  devinAgentDef,
  opencodeAgentDef,
  byokOpenCodeAgentDef,
  hermesAgentDef,
  traeCliAgentDef,
  grokBuildAgentDef,
  kimiAgentDef,
  cursorAgentDef,
  qwenAgentDef,
  qoderAgentDef,
  copilotAgentDef,
  ampAgentDef,
  piAgentDef,
  kiroAgentDef,
  kiloAgentDef,
  vibeAgentDef,
  deepseekAgentDef,
  deepseekHarnessAgentDef,
  aiderAgentDef,
  antigravityAgentDef,
  reasonixAgentDef,
  codebuddyAgentDef,
  mimoAgentDef,
  atomcodeAgentDef,
];

/**
 * The agents this build ships: only the in-process Databricks agent.
 *
 * `AGENT_DEFS` below is the same list. Local agent profiles (which wrap a
 * user-installed CLI) are not loaded, since they would reopen a spawned,
 * non-Databricks model path.
 */
export const SHIPPED_AGENT_DEFS: RuntimeAgentDef[] = [databricksAgentDef];

export function readLocalAgentProfileDefs(
  baseDefs: RuntimeAgentDef[] = SHIPPED_AGENT_DEFS,
): RuntimeAgentDef[] {
  return readLocalAgentProfileDefsFromFile(baseDefs);
}

export const AGENT_DEFS: RuntimeAgentDef[] = [...SHIPPED_AGENT_DEFS];

const ids = new Set();
for (const def of AGENT_DEFS) {
  if (ids.has(def.id)) {
    throw new Error(`Duplicate agent definition id: ${def.id}`);
  }
  ids.add(def.id);
}

export function getAgentDef(id: string): RuntimeAgentDef | null {
  return AGENT_DEFS.find((a) => a.id === id) || null;
}
