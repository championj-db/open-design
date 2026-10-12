// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchAuthSession,
  isAuthSessionResponse,
  isPlatformManagedAuth,
  resetAuthSessionForTests,
  useAuthSession,
} from '../../src/hooks/useAuthSession';

const DATABRICKS_SESSION = {
  provider: 'databricks',
  user: {
    id: '42',
    userName: 'ada@example.com',
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
    groups: [],
  },
} as const;

afterEach(() => {
  resetAuthSessionForTests();
  vi.unstubAllGlobals();
});

function stubFetch(responses: Array<Response | Error>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('useAuthSession', () => {
  it('reads /api/auth/session once per page and reports platform-managed auth', async () => {
    const fetchMock = stubFetch([new Response(JSON.stringify(DATABRICKS_SESSION))]);
    const first = renderHook(() => useAuthSession());
    await waitFor(() => expect(first.result.current).toEqual(DATABRICKS_SESSION));
    expect(isPlatformManagedAuth(first.result.current)).toBe(true);

    const second = renderHook(() => useAuthSession());
    expect(second.result.current).toEqual(DATABRICKS_SESSION);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/session');
  });

  it('does not cache a failed read', async () => {
    const fetchMock = stubFetch([
      new Error('offline'),
      new Response(JSON.stringify({ provider: 'local', user: null })),
    ]);
    expect(await fetchAuthSession()).toBeNull();
    expect(await fetchAuthSession()).toEqual({ provider: 'local', user: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats an older daemon without the endpoint as local auth', async () => {
    stubFetch([new Response('Not found', { status: 404 })]);
    expect(await fetchAuthSession()).toBeNull();
    expect(isPlatformManagedAuth(null)).toBe(false);
  });

  it('validates the response shape', () => {
    expect(isAuthSessionResponse(DATABRICKS_SESSION)).toBe(true);
    expect(isAuthSessionResponse({ provider: 'local', user: null })).toBe(true);
    expect(isAuthSessionResponse({ provider: 'okta', user: null })).toBe(false);
    expect(isAuthSessionResponse({ provider: 'databricks', user: { id: 1 } })).toBe(false);
  });
});
