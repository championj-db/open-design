import { AsyncLocalStorage } from 'node:async_hooks';

import type Database from 'better-sqlite3';
import type { RequestHandler, Response } from 'express';

import { sendApiError } from '../http/api-errors.js';
import { databricksRequestContext } from './request-context.js';

// Per-user project visibility on a Databricks App. Every signed-in user shares
// one daemon, so without this each of them would see every project. Here a
// project belongs to the Databricks user whose request created it, and a
// signed-in user can reach only their own projects:
//
//   - creation: `insertProject` runs inside the request's async context
//     (`runAsDatabricksUser`), so the new project is recorded against that
//     user (`databricks_project_owners`);
//   - access: any request that names a project — in its path, a run id, or a
//     `projectId` / `projectIds` field — is refused with 404 unless the caller
//     owns it;
//   - lists: JSON responses drop the projects, and the items tied to projects,
//     the caller does not own.
//
// A project with no owner (created before this existed) is hidden from every
// signed-in user. In-container callers (agent tools on loopback) carry no
// user and are not filtered, as before. A project that backs a design system
// follows that design system's sharing instead (`sharedProjectAccess`, see
// design-system-sharing.ts): read-only for a user it was shared with. Catalogs
// that are not projects at all — skills, templates, plugins — stay shared.

const OWNER_TABLE = 'databricks_project_owners';

export interface ProjectOwnership {
  ownerOf(projectId: string): string | null;
  assign(projectId: string, userId: string): void;
  /** True when this user may reach the project. */
  visibleTo(projectId: string, userId: string): boolean;
}

export function createProjectOwnership(db: Database.Database): ProjectOwnership {
  db.exec(`CREATE TABLE IF NOT EXISTS ${OWNER_TABLE} (
    project_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  const select = db.prepare(`SELECT user_id AS userId FROM ${OWNER_TABLE} WHERE project_id = ?`);
  const insert = db.prepare(`INSERT OR IGNORE INTO ${OWNER_TABLE} (project_id, user_id, created_at) VALUES (?, ?, ?)`);
  const ownership: ProjectOwnership = {
    ownerOf(projectId) {
      return (select.get(projectId) as { userId: string } | undefined)?.userId ?? null;
    },
    assign(projectId, userId) {
      // First owner wins: a later request can never take a project over.
      insert.run(projectId, userId, Date.now());
    },
    visibleTo(projectId, userId) {
      return ownership.ownerOf(projectId) === userId;
    },
  };
  return ownership;
}

const currentUser = new AsyncLocalStorage<string>();

/** Run `fn` (the rest of a request) as this Databricks user, for project attribution. */
export function runAsDatabricksUser<T>(userId: string, fn: () => T): T {
  return currentUser.run(userId, fn);
}

export function currentDatabricksUserId(): string | null {
  return currentUser.getStore() ?? null;
}

/** Record each project inserted during a signed-in request against that user. */
export function attributeNewProjects(
  ownership: ProjectOwnership,
  onProjectInserted: (listener: (projectId: string) => void) => unknown,
): void {
  onProjectInserted((projectId) => {
    const userId = currentDatabricksUserId();
    if (userId) ownership.assign(projectId, userId);
  });
}

const PROJECT_PATHS = [
  /^\/api\/projects\/([^/]+)/,
  /^\/api\/workspaces\/[^/]+\/projects\/([^/]+)/,
];
const RUN_PATH = /^\/api\/runs\/([^/]+)/;
// Literal segments under /api/runs that are not run ids.
const RUN_PATH_LITERALS = new Set(['by-plugin-workflow']);

/** Project ids a request names. Unknown run ids resolve to nothing; the route answers those. */
export function projectIdsInRequest(
  req: { path: string; body?: unknown; query?: unknown },
  projectIdForRun: (runId: string) => string | null,
): string[] {
  const ids = new Set<string>();
  for (const pattern of PROJECT_PATHS) {
    const match = pattern.exec(req.path);
    if (match) ids.add(decodeURIComponent(match[1]!));
  }
  const run = RUN_PATH.exec(req.path);
  if (run && !RUN_PATH_LITERALS.has(run[1]!)) {
    const projectId = projectIdForRun(decodeURIComponent(run[1]!));
    if (projectId) ids.add(projectId);
  }
  for (const source of [req.body, req.query]) {
    if (!isRecord(source)) continue;
    if (typeof source.projectId === 'string' && source.projectId) ids.add(source.projectId);
    if (Array.isArray(source.projectIds)) {
      for (const id of source.projectIds) if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Drop what this user may not see from a JSON response: `projects[]` entries
 * by `id`, entries of any top-level list by `projectId`, `*projectIds` lists,
 * and the whole body when it is itself a record of someone else's project.
 * Returns null when the body must be withheld.
 */
export function redactForUser(body: unknown, visible: (projectId: string) => boolean): unknown {
  if (!isRecord(body)) return body;
  if (typeof body.projectId === 'string' && body.projectId && !visible(body.projectId)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!Array.isArray(value)) {
      out[key] = value;
      continue;
    }
    out[key] = value.filter((item) => {
      if (typeof item === 'string') return !/projectids$/i.test(key) || visible(item);
      if (!isRecord(item)) return true;
      if (key === 'projects' && typeof item.id === 'string' && !visible(item.id)) return false;
      if (typeof item.projectId === 'string' && item.projectId && !visible(item.projectId)) return false;
      return true;
    });
  }
  return out;
}

/**
 * Mounted after the Databricks auth middleware. Requests with no signed-in
 * user (in-container loopback callers) pass untouched.
 */
export function createProjectOwnershipMiddleware({
  ownership,
  projectExists,
  sharedProjectAccess,
  projectIdForRun,
}: {
  ownership: ProjectOwnership;
  projectExists: (projectId: string) => boolean;
  /**
   * What a user who does not own the project may do with it: projects that
   * back a design system shared with them are readable.
   */
  sharedProjectAccess: (projectId: string, userId: string) => 'none' | 'read' | 'write';
  projectIdForRun: (runId: string) => string | null;
}): RequestHandler {
  return (req, res, next) => {
    const user = databricksRequestContext(req)?.user;
    if (!user) return next();
    const access = (projectId: string): 'none' | 'read' | 'write' =>
      ownership.visibleTo(projectId, user.id) || !projectExists(projectId)
        ? 'write'
        : sharedProjectAccess(projectId, user.id);
    const visible = (projectId: string) => access(projectId) !== 'none';
    // A project id that does not exist yet passes: the route answers 404, or
    // creates it and attribution claims it for this user.
    const named = projectIdsInRequest({ path: req.originalUrl.split('?')[0]!, body: req.body, query: req.query }, projectIdForRun);
    if (named.some((projectId) => !visible(projectId))) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    }
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating && named.some((projectId) => access(projectId) === 'read')) {
      return sendApiError(res, 403, 'FORBIDDEN', 'This project was shared with you to view, not to edit');
    }
    const json = res.json.bind(res) as Response['json'];
    res.json = ((body: unknown) => {
      const redacted = redactForUser(body, visible);
      if (redacted === null) {
        res.status(404);
        return json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
      }
      return json(redacted);
    }) as Response['json'];
    return runAsDatabricksUser(user.id, next);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
