import { useEffect, useState } from 'react';
import type { AuthSessionResponse, AuthSessionUser } from '@open-design/contracts';

// One shared read of `GET /api/auth/session` per page load: who the daemon
// says the caller is. Under Databricks auth the answer can only change when
// the Apps proxy signs a different user in, which is a full page load, so a
// successful read is kept for the life of the page. A failed read is not
// cached; the next mount asks again.
let sessionRequest: Promise<AuthSessionResponse | null> | null = null;
let resolvedSession: AuthSessionResponse | null = null;

function isAuthSessionUser(value: unknown): value is AuthSessionUser {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.userName === 'string';
}

export function isAuthSessionResponse(value: unknown): value is AuthSessionResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.provider === 'databricks' || candidate.provider === 'local') &&
    (candidate.user === null || isAuthSessionUser(candidate.user))
  );
}

export function fetchAuthSession(): Promise<AuthSessionResponse | null> {
  sessionRequest ??= (async () => {
    try {
      const resp = await fetch('/api/auth/session');
      const json: unknown = resp.ok ? await resp.json() : null;
      if (!isAuthSessionResponse(json)) throw new Error('unrecognised auth session response');
      resolvedSession = json;
      return json;
    } catch {
      sessionRequest = null;
      return null;
    }
  })();
  return sessionRequest;
}

/** Test seam: forget the page-level session read. */
export function resetAuthSessionForTests(): void {
  sessionRequest = null;
  resolvedSession = null;
}

/** Test seam: answer the page-level session read as if the daemon had. */
export function seedAuthSessionForTests(session: AuthSessionResponse): void {
  resolvedSession = session;
  sessionRequest = Promise.resolve(session);
}

/** Null until the daemon answers (or when it cannot). */
export function useAuthSession(): AuthSessionResponse | null {
  const [session, setSession] = useState<AuthSessionResponse | null>(resolvedSession);
  useEffect(() => {
    let live = true;
    void fetchAuthSession().then((next) => {
      if (live && next) setSession(next);
    });
    return () => {
      live = false;
    };
  }, []);
  return session;
}

/**
 * The platform (Databricks Apps) signs users in, so the shell must not offer
 * or redirect to the OpenDesign Cloud sign-in.
 */
export function isPlatformManagedAuth(session: AuthSessionResponse | null): boolean {
  return session?.provider === 'databricks';
}

/**
 * OpenDesign Cloud account surfaces (sign-in and sign-up prompts, credits,
 * plans, and the Cloud's community links) may show only once the daemon has
 * said the caller is a local user. On a Databricks App the platform signs users
 * in and the daemon refuses the Cloud sign-in, so they stay hidden — including
 * while the session is still loading, so a Databricks page never flashes one.
 */
export function cloudAccountSurfacesAllowed(session: AuthSessionResponse | null): boolean {
  return session?.provider === 'local';
}

export function useCloudAccountSurfacesAllowed(): boolean {
  return cloudAccountSurfacesAllowed(useAuthSession());
}
