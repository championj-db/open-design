import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';
import { openSettingsDialog } from '../lib/playwright/amr.js';
import { suppressWhatsNew } from '../lib/playwright/mock-factory.js';

// Regression for #4509: the MCP server setup snippet renders inside a dark
// `<pre><code>` block, but the inner `<code>` used to inherit the global
// inline-`code` chip style (light background + padding + rounded corners). On
// a wrapped `claude mcp add-json` one-liner that painted a light rounded
// rectangle behind every wrapped segment — reading as permanent selection
// highlights. The inner `<code>` must stay transparent.

const STORAGE_KEY = 'open-design:config';

test.beforeEach(async ({ page }) => {
  // The entry home mounts `WhatsNewPopup` (EntryShell.tsx) and its backdrop sits
  // at z-index 1500 — above the z-index 120 chrome that owns the rail/settings
  // controls this spec clicks. A live release card would swallow those clicks.
  await suppressWhatsNew(page);
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, JSON.stringify({
      mode: 'api', apiProtocol: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash', agentId: null, skillId: null, designSystemId: null,
      onboardingCompleted: true, agentModels: {}, privacyDecisionAt: 1,
      telemetry: { metrics: false, content: false, artifactManifest: false },
    }));
  }, STORAGE_KEY);
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { config: { onboardingCompleted: true, agentId: null, skillId: null, designSystemId: null, agentModels: {}, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } } } });
  });
});

test('[P1] MCP server snippet code stays transparent, not the inline-code chip (#4509)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const settings = await openSettingsDialog(page);
  await settings.getByRole('button', { name: /^MCP server\b/ }).click();

  const code = settings.locator('pre code').filter({ hasText: 'claude mcp add-json' });
  await expect(code).toBeVisible({ timeout: T.short });

  const style = await code.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { background: computed.backgroundColor, padding: computed.padding };
  });

  // Transparent (Chromium reports `rgba(0, 0, 0, 0)`) — the inline-code chip
  // background must not leak in. Before the fix this was the light
  // `--bg-subtle` (e.g. `rgb(244, 245, 247)`) with `1px 5px` padding.
  expect(style.background).toBe('rgba(0, 0, 0, 0)');
  expect(style.padding).toBe('0px');
});

