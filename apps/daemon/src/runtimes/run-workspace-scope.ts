// The Workspace a run's project was bound to when the run was created,
// frozen on the run so every attempt sees the same binding.
import { getWorkspaceProjectByProjectId } from '../db.js';

type SqliteDb = Parameters<typeof getWorkspaceProjectByProjectId>[0];

export type PinnedRunWorkspaceScope = Readonly<{
  schemaVersion: 1;
  projectId: string;
  workspaceId: string;
  // Project writes are creator-gated. Freeze the same member for dynamic
  // library reads; older persisted Runs may not carry this field.
  workspaceMemberId?: string | null;
  source: 'persisted_project_binding';
}>;

export type AccountScopedRunWorkspaceScope = Readonly<{
  schemaVersion: 1;
  projectId: string;
  workspaceId: null;
  source: 'unbound_account';
}>;

export type RunWorkspaceScope =
  | PinnedRunWorkspaceScope
  | AccountScopedRunWorkspaceScope;

export function accountScopedRunWorkspaceScopeForProject(
  projectId: string,
): AccountScopedRunWorkspaceScope {
  return Object.freeze({
    schemaVersion: 1,
    projectId,
    workspaceId: null,
    source: 'unbound_account',
  });
}

/**
 * Freeze the project's Workspace binding before a run is created.
 *
 * This is the only function in the run path that reads the mutable project
 * binding. Its result is stored on the run and reused for every attempt. The
 * separate account-scoped proof records a genuinely unbound local project;
 * null remains "no proof" and may not silently select a wallet.
 */
export function pinRunWorkspaceScopeForProject(
  db: SqliteDb,
  projectId: string,
): PinnedRunWorkspaceScope | null {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) return null;
  const binding = getWorkspaceProjectByProjectId(db, normalizedProjectId);
  const workspaceId =
    typeof binding?.workspaceId === 'string' && binding.workspaceId.trim()
      ? binding.workspaceId.trim()
      : null;
  if (!workspaceId) return null;
  return Object.freeze({
    schemaVersion: 1,
    projectId: normalizedProjectId,
    workspaceId,
    workspaceMemberId: binding?.createdByWorkspaceMemberId?.trim() || null,
    source: 'persisted_project_binding',
  });
}
