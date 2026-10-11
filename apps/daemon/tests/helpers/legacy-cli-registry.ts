// Test-only registry for server-level suites that drive chat runs through the
// legacy CLI runtimes' fake binaries.
//
// On Databricks the product registry exposes only the in-process Databricks
// agent; the CLI runtime defs are unregistered but still on disk. Suites such
// as `chat-route.test.ts` use those defs plus fake CLIs on PATH as a harness
// for behavior that is not CLI-specific (prompt composition, skill staging,
// run finalization). Mock `src/runtimes/registry.js` with this factory to keep
// that coverage without registering the CLIs in the product:
//
//   vi.mock('../src/runtimes/registry.js', async (importOriginal) =>
//     (await import('./helpers/legacy-cli-registry.js')).legacyCliRegistryMock(importOriginal));
//
// Remove with the CLI-runtime strip follow-up, once these suites run against a
// mock Model Serving endpoint instead.
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

type RegistryModule = typeof import('../../src/runtimes/registry.js');

export async function legacyCliRegistryMock(
  importOriginal: () => Promise<RegistryModule>,
): Promise<RegistryModule> {
  const original = await importOriginal();
  const defs: RuntimeAgentDef[] = [...original.AGENT_DEFS, ...original.UNREGISTERED_CLI_AGENT_DEFS];
  return {
    ...original,
    AGENT_DEFS: defs,
    SHIPPED_AGENT_DEFS: defs,
    getAgentDef: (id: string) => defs.find((def) => def.id === id) ?? null,
  };
}
