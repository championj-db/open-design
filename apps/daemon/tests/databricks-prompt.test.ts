import { describe, expect, it } from 'vitest';

import { composeSystemPrompt } from '../src/prompts/system.js';

// The Databricks agent writes files but cannot run the OpenDesign CLI, so its
// prompt must carry the direction library inline instead of telling it to
// fetch specs with `od tools directions`.
describe('Databricks agent prompt', () => {
  const compose = (agentId: string) =>
    composeSystemPrompt({
      agentId,
      streamFormat: 'claude-stream-json',
      executionProfile: 'filesystem',
      promptCoreVariant: 'slim',
      metadata: { kind: 'prototype' },
    } as Parameters<typeof composeSystemPrompt>[0]);

  it('inlines direction specs rather than an index to pull from', () => {
    const databricks = compose('databricks');
    const claude = compose('claude');
    expect(claude).toContain('tools directions --id');
    expect(databricks).not.toContain('tools directions --id <id>` directly');
    expect(databricks.length).toBeGreaterThan(claude.length);
  });
});
