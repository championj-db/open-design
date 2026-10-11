// @vitest-environment jsdom

/**
 * The rail's bottom-left footer slot. `CloudSignInTip` was the AMR (vela)
 * device-auth sign-in card; with AMR removed on Databricks it renders nothing
 * and makes no request. `RailAccountSyncTip` (the inert syncing readout) is
 * unaffected.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudSignInTip, RailAccountSyncTip } from '../../src/components/CloudSignInTip';
import { I18nProvider } from '../../src/i18n';

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});
describe('CloudSignInTip', () => {
  it('renders nothing while the AMR account UI is off (no AMR sign-in on Databricks)', () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { container } = render(
      <I18nProvider initial="en">
        <CloudSignInTip />
      </I18nProvider>,
    );
    expect(container.innerHTML).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// recvqgpXSYFNTq: "退出登录后再登录，左下角的头像加载的有些慢" — the rail's
// bottom-left callout slot used to go fully blank between `CloudSignInTip`
// unmounting (sign-in just succeeded) and the account row appearing (the
// workspace-context re-read landing). `EntryShell` now renders this in that
// exact same footer slot instead of `null` for that window.
describe('RailAccountSyncTip', () => {
  function renderSyncTip() {
    return render(
      <I18nProvider initial="en">
        <RailAccountSyncTip />
      </I18nProvider>,
    );
  }

  it('renders an inert status readout instead of leaving the slot blank', async () => {
    renderSyncTip();
    const status = await screen.findByTestId('entry-rail-account-sync-tip');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    // Same headline as the callout it replaces (now screen-reader-only, see
    // the skeleton-shape test below), so assistive tech still announces the
    // swap as a state change on the same card rather than a different one.
    expect(status.textContent).toContain('OpenDesign Cloud');
    expect(status.textContent).toContain('Loading');
  });

  it('is not interactive — no button/section semantics or click affordance', async () => {
    renderSyncTip();
    const status = await screen.findByTestId('entry-rail-account-sync-tip');
    expect(status.tagName).toBe('DIV');
    expect(status.querySelector('button')).toBeNull();
  });

  // Follow-up (2026-07-24 product feedback): a spinner + "Loading…" card read
  // as a separate notification and visibly jumped in size/position once the
  // real account row (`.entry-nav-rail__account-trigger`, EntryNavRail.tsx)
  // landed in its place. This locks in the skeleton shape — an avatar
  // placeholder + a name-bar placeholder, sized after that real row — so a
  // regression back to the spinner+text card fails this test instead of only
  // showing up in a screenshot diff.
  it('renders an avatar + name skeleton shaped like the real account row, not a spinner card', async () => {
    renderSyncTip();
    const status = await screen.findByTestId('entry-rail-account-sync-tip');
    expect(status.querySelector('.entry-rail-account-skeleton__avatar')).not.toBeNull();
    expect(status.querySelector('.entry-rail-account-skeleton__name')).not.toBeNull();
    // The old card rendered a visible "OpenDesign Cloud" / "Loading…" pair
    // of text nodes for sighted users; that text now exists for assistive
    // tech only, so a plain <strong> headline must not reappear inline.
    expect(status.querySelector('strong')).toBeNull();
    // No spinner icon either — the shimmering skeleton blocks are the loading
    // indicator now, not a spinning glyph next to a card body.
    expect(status.querySelector('svg')).toBeNull();
  });
});
