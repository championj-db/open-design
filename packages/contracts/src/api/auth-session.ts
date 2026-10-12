/**
 * Who authenticated the caller of `GET /api/auth/session`.
 *
 * - `databricks`: the daemon runs as a Databricks App (`OD_AUTH_MODE=databricks`).
 *   The Apps proxy signs every user in before a request reaches the container
 *   and forwards a short-lived on-behalf-of token; the daemon verifies that
 *   token against SCIM `Me` on every request, so `user` is a verified identity.
 * - `local`: the daemon's own loopback / `OD_API_TOKEN` model. It has no notion
 *   of individual users, so `user` is always null.
 */
export type AuthSessionProvider = 'databricks' | 'local';

export interface AuthSessionUser {
  /** Stable SCIM id of the user (or service principal). */
  id: string;
  /** SCIM `userName`: the email for human users, the application id for service principals. */
  userName: string;
  displayName: string | null;
  email: string | null;
  /** Display names of the workspace groups SCIM `Me` reports. */
  groups: string[];
}

export interface AuthSessionResponse {
  provider: AuthSessionProvider;
  /**
   * The verified caller. Null under `local`, and under `databricks` for
   * in-container callers (agent tools, the local `od` CLI) that never pass
   * through the Apps proxy and therefore carry no user token.
   */
  user: AuthSessionUser | null;
}
