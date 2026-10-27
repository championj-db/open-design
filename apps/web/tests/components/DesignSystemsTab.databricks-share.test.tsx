// @vitest-environment jsdom

// On a Databricks App there is no OpenDesign Cloud team workspace, so the Team
// collection and "Share to team" must not depend on one: the daemon shares a
// design system with every user of the app (databricks/design-system-sharing.ts)
// through the same routes, which take no workspace headers there.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@open-design/contracts';

import { DesignSystemsTab } from '../../src/components/DesignSystemsTab';
import { resetAuthSessionForTests, seedAuthSessionForTests } from '../../src/hooks/useAuthSession';
import { I18nProvider } from '../../src/i18n';

vi.mock('../../src/collab/workspace-events', () => ({
  useWorkspaceInvalidation: vi.fn(() => ({ connected: false })),
}));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

vi.mock('../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/registry')>();
  return {
    ...actual,
    fetchDesignSystem: vi.fn(async (id: string) => ({
      id,
      title: 'My Design System',
      summary: 'Owned by me.',
      category: 'Custom',
      body: `# ${id}\n\n## Colors\n- Primary #111111`,
    })),
  };
});

vi.mock('../../src/collab/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({ context: null, loading: false, refresh: vi.fn() }),
  useWorkspaceBilling: () => ({ membershipTier: '' }),
}));

const MY_SYSTEM: DesignSystemSummary = {
  id: 'user:my-ds',
  title: 'My Design System',
  category: 'Custom',
  summary: 'Owned by me.',
  surface: 'web',
  source: 'user',
  status: 'draft',
  isEditable: true,
};

let shared = false;
let calls: Array<{ url: string; method: string; headers: Headers }> = [];

beforeEach(() => {
  shared = false;
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: new Headers(init?.headers) });
    let body: unknown = {};
    if (url.endsWith('/api/workspace/design-systems/team')) {
      body = { ids: shared ? [MY_SYSTEM.id] : [], resources: shared ? [{ id: MY_SYSTEM.id, canUnshare: true }] : [] };
    } else if (url.endsWith('/share') && method === 'POST') {
      shared = true;
      body = { shared: true, version: 1 };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetAuthSessionForTests();
  seedAuthSessionForTests({ provider: 'local', user: null });
});

function renderTab() {
  return render(
    <I18nProvider initial="en">
      <DesignSystemsTab
        loading={false}
        systems={[MY_SYSTEM]}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />
    </I18nProvider>,
  );
}

describe('DesignSystemsTab on a Databricks App', () => {
  it('shares a design system with the app\'s users without a Cloud team workspace', async () => {
    seedAuthSessionForTests({
      provider: 'databricks',
      user: { id: 'u1', userName: 'ada@example.com' } as never,
    });
    renderTab();

    await waitFor(() => expect(screen.getByRole('tab', { name: /Team/i })).toBeTruthy());
    fireEvent.click(await screen.findByTestId('design-kit-more-actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Share to team' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const share = calls.find((call) => call.method === 'POST')!;
    expect(share.url).toBe('/api/workspace/design-systems/user%3Amy-ds/share');
    expect(share.headers.get('x-od-workspace-id')).toBeNull();
    // Shared systems move to the Team collection.
    await waitFor(() => expect(screen.queryByTestId('design-kit-view-user:my-ds')).toBeNull());
    fireEvent.click(screen.getByRole('tab', { name: /Team/i }));
    expect(await screen.findByTestId('design-kit-view-user:my-ds')).toBeTruthy();
  });

  it('offers no Team collection to a local session without a team workspace', async () => {
    renderTab();
    await screen.findByTestId('design-kit-view-user:my-ds');
    expect(screen.queryByRole('tab', { name: /Team/i })).toBeNull();
    expect(calls.some((call) => call.url.includes('/api/workspace/design-systems'))).toBe(false);
  });
});
