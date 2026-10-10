// @vitest-environment jsdom

/**
 * The Vela/AMR daemon routes (`/api/integrations/vela/*`, `/api/amr/*`) were
 * removed with the move to Databricks. Every retained AMR client helper must
 * answer a stable signed-out stub WITHOUT touching the network, and the AMR
 * sign-in / sign-out controls must not render, so nothing can call a deleted
 * endpoint.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordAmrEntry } from '../../src/analytics/amr-attribution';
import { AmrLoginPill } from '../../src/components/AmrLoginPill';
import { CloudSignInTip } from '../../src/components/CloudSignInTip';
import { EntryNavRail, resetWorkspaceDirectoryCache } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';
import {
  isAmrLoggedIn,
  markAccountMessageRead,
  pullMessageCenter,
} from '../../src/message-center-client';
import {
  AMR_ACCOUNT_UI_ENABLED,
  cancelVelaLogin,
  fetchAmrModels,
  fetchAmrWalletSnapshot,
  fetchVelaLoginStatus,
  readVelaLoginStatus,
  startVelaLogin,
  velaLogout,
} from '../../src/providers/daemon';

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  resetWorkspaceDirectoryCache();
});

describe('removed AMR/Vela account surface', () => {
  it('keeps the AMR account UI disabled', () => {
    expect(AMR_ACCOUNT_UI_ENABLED).toBe(false);
  });

  it('answers every Vela/AMR helper with a signed-out stub and no request', async () => {
    await expect(readVelaLoginStatus({ refresh: true })).resolves.toMatchObject({ ok: false, body: null });
    await expect(fetchVelaLoginStatus()).resolves.toBeNull();
    await expect(fetchAmrWalletSnapshot()).resolves.toBeNull();
    await expect(fetchAmrModels()).resolves.toBeNull();
    await expect(startVelaLogin(null, null, undefined)).resolves.toMatchObject({ ok: false });
    await expect(cancelVelaLogin('pending-amr-auth-abc-def')).resolves.toEqual({ ok: true, canceled: false });
    await expect(velaLogout()).resolves.toEqual({ ok: true });
    await expect(isAmrLoggedIn()).resolves.toBe(false);
    await expect(pullMessageCenter({ locale: 'en', loggedIn: true })).resolves.toEqual([]);
    await expect(markAccountMessageRead('m1')).resolves.toBeUndefined();
    recordAmrEntry(() => {}, 'settings_cloud_callout');
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders no AMR sign-in controls and makes no request', async () => {
    const { container } = render(
      <I18nProvider>
        <AmrLoginPill signInLabel="Sign in" />
        <CloudSignInTip />
      </I18nProvider>,
    );
    await Promise.resolve();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers no AMR sign-out in the rail account menu', () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const context = {
      workspaceId: 'ws-team',
      workspaceType: 'team',
      workspaceMemberId: 'wm-1',
      role: 'owner',
      memberStatus: 'active',
      lifecycleState: 'active',
      billingState: 'active',
      planId: 'team_plus',
      displayName: 'Leaf',
      seatSummary: { seatLimit: 5, usedSeats: 1, availableSeats: 4, isSeatFull: false },
      permissions: { canInviteMembers: true, canViewWorkspaceSettings: true },
      workspaceSettingsUrl: 'https://web.example.com/console/settings?workspaceId=ws-team',
    } as unknown as WorkspaceCollabContext;
    render(
      <I18nProvider initial="en">
        <EntryNavRail view="home" onViewChange={() => {}} onNewProject={() => {}} open context={context} billing={null} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByTestId('entry-nav-account'));
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0);
    expect(screen.queryByRole('menuitem', { name: /sign out|log out/i })).toBeNull();
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toMatch(/\/api\/(integrations\/vela|amr)\b/);
    }
  });
});
