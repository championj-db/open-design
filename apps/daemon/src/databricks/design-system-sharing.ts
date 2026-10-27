import path from 'node:path';

import type Database from 'better-sqlite3';
import type { RequestHandler, Response } from 'express';

import { sendApiError } from '../http/api-errors.js';
import { currentDatabricksUserId } from './project-ownership.js';
import { databricksRequestContext } from './request-context.js';

// Design-system sharing on a Databricks App. Every signed-in user shares one
// daemon, and OpenDesign Cloud's team workspaces (the usual way to share a
// design system) are switched off, so sharing is modelled here instead:
//
//   - creation: a new user design system is recorded against the Databricks
//     user whose request created it (`attributeNewDesignSystems`, fed by
//     design-systems/created-events.ts), and starts private;
//   - sharing: its owner shares it with every user of the app, or takes it
//     back, through the same `/api/workspace/design-systems/...` routes the
//     web's "Share to team" action already calls;
//   - access: other users cannot see a private design system at all (404);
//     a shared one they can browse, preview, download and design with, but
//     not edit, publish, share or delete (403). The projects that back a
//     design system follow the same rule (`designSystemAccess`, consumed by
//     project-ownership.ts).
//
// Built-in design systems are untouched. A user design system with no owner
// (created before this existed, or by an in-container caller) stays open to
// every user, as all of them were before.

const OWNER_TABLE = 'databricks_design_system_owners';
const USER_PREFIX = 'user:';

export type DesignSystemAccess = 'none' | 'read' | 'write';

export interface DesignSystemSharing {
  ownerOf(designSystemId: string): string | null;
  isShared(designSystemId: string): boolean;
  /** Record a freshly created design system: owned by `userId` and private, or unowned. */
  recordCreated(designSystemId: string, userId: string | null): void;
  setShared(designSystemId: string, shared: boolean): void;
}

export function createDesignSystemSharing(db: Database.Database): DesignSystemSharing {
  db.exec(`CREATE TABLE IF NOT EXISTS ${OWNER_TABLE} (
    design_system_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  const select = db.prepare(`SELECT user_id AS userId, shared FROM ${OWNER_TABLE} WHERE design_system_id = ?`);
  // A create reserved a directory that did not exist, so any earlier row is
  // left over from a deleted design system of the same id: replace it.
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO ${OWNER_TABLE} (design_system_id, user_id, shared, created_at) VALUES (?, ?, 0, ?)`,
  );
  const remove = db.prepare(`DELETE FROM ${OWNER_TABLE} WHERE design_system_id = ?`);
  const updateShared = db.prepare(`UPDATE ${OWNER_TABLE} SET shared = ? WHERE design_system_id = ?`);
  const row = (id: string) => select.get(id) as { userId: string; shared: number } | undefined;
  return {
    ownerOf: (id) => row(id)?.userId ?? null,
    isShared: (id) => row(id)?.shared === 1,
    recordCreated(id, userId) {
      if (userId) upsert.run(id, userId, Date.now());
      else remove.run(id);
    },
    setShared(id, shared) {
      updateShared.run(shared ? 1 : 0, id);
    },
  };
}

/** What `userId` may do with a design system. */
export function designSystemAccess(
  sharing: DesignSystemSharing,
  designSystemId: string,
  userId: string,
): DesignSystemAccess {
  if (!designSystemId.startsWith(USER_PREFIX)) return 'write';
  const owner = sharing.ownerOf(designSystemId);
  if (owner === null || owner === userId) return 'write';
  return sharing.isShared(designSystemId) ? 'read' : 'none';
}

/** Attribute each design system created under the user design-system root to the signed-in user. */
export function attributeNewDesignSystems(
  sharing: DesignSystemSharing,
  userDesignSystemsRoot: string,
  onCreated: (listener: (root: string, dirId: string) => void) => unknown,
): void {
  const root = path.resolve(userDesignSystemsRoot);
  onCreated((createdRoot, dirId) => {
    if (createdRoot !== root) return;
    sharing.recordCreated(`${USER_PREFIX}${dirId}`, currentDatabricksUserId());
  });
}

/**
 * The user design system a project exists to edit or extract, or null for an
 * ordinary design project (which may merely *use* a design system).
 */
export function backingDesignSystemId(
  project: { designSystemId?: string | null; metadata?: unknown } | null,
): string | null {
  if (!project) return null;
  const metadata = isRecord(project.metadata) ? project.metadata : {};
  let id: unknown = null;
  if (metadata.importedFrom === 'design-system') id = project.designSystemId;
  else if (metadata.importedFrom === 'brand-extraction') id = metadata.brandDesignSystemId ?? project.designSystemId;
  return typeof id === 'string' && id.startsWith(USER_PREFIX) ? id : null;
}

const TEAM_INDEX_PATH = '/api/workspace/design-systems/team';
const SHARE_PATH = /^\/api\/workspace\/design-systems\/([^/]+)\/share$/;
const CATALOG_PATH = '/api/design-systems';
const DESIGN_SYSTEM_PATH = /^\/api\/design-systems\/([^/]+)(\/.*)?$/;
// Literal segments under /api/design-systems that are not design-system ids.
const DESIGN_SYSTEM_PATH_LITERALS = new Set(['generation-jobs', 'import']);
const BRAND_PATH = /^\/api\/brands\/([^/]+)(\/.*)?$/;

/**
 * Mounted after the Databricks auth middleware. Requests with no signed-in
 * user (in-container loopback callers) pass untouched.
 */
export function createDesignSystemSharingMiddleware({
  sharing,
  listUserDesignSystemIds,
  designSystemIdForBrand,
}: {
  sharing: DesignSystemSharing;
  /** Every user design system id in the catalog. */
  listUserDesignSystemIds: () => Promise<string[]>;
  designSystemIdForBrand: (brandId: string) => string | null;
}): RequestHandler {
  return (req, res, next) => {
    const user = databricksRequestContext(req)?.user;
    if (!user) return next();
    const requestPath = req.originalUrl.split('?')[0]!;
    const access = (id: string) => designSystemAccess(sharing, id, user.id);
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';

    if (requestPath === TEAM_INDEX_PATH && req.method === 'GET') {
      void listUserDesignSystemIds()
        .then((ids) => {
          // Shared with every user: those their owner shared, and the unowned
          // ones that predate sharing.
          const shared = ids.filter((id) => sharing.ownerOf(id) === null || sharing.isShared(id));
          res.json({
            ids: shared,
            resources: shared.map((id) => ({ id, canUnshare: sharing.ownerOf(id) === user.id })),
          });
        })
        .catch(next);
      return;
    }

    const share = SHARE_PATH.exec(requestPath);
    if (share && (req.method === 'POST' || req.method === 'DELETE')) {
      const id = safeDecode(share[1]!);
      void listUserDesignSystemIds()
        .then((ids) => {
          if (!id || !ids.includes(id) || access(id) === 'none') {
            return sendApiError(res, 404, 'NOT_FOUND', 'Design system not found');
          }
          if (sharing.ownerOf(id) !== user.id) {
            return sendApiError(res, 403, 'FORBIDDEN', 'Only the user who created this design system can share it');
          }
          sharing.setShared(id, req.method === 'POST');
          res.json(req.method === 'POST' ? { shared: true, version: 1 } : { unshared: true });
        })
        .catch(next);
      return;
    }

    if (requestPath === CATALOG_PATH && req.method === 'GET') {
      interceptJson(res, (body) => {
        if (!isRecord(body) || !Array.isArray(body.designSystems)) return body;
        return {
          ...body,
          designSystems: body.designSystems
            .filter((system) => !isRecord(system) || typeof system.id !== 'string' || access(system.id) !== 'none')
            .map((system) => (isRecord(system) && typeof system.id === 'string' && access(system.id) === 'read'
              ? markReadOnly(system)
              : system)),
        };
      });
      return next();
    }

    const brand = BRAND_PATH.exec(requestPath);
    const designSystem = DESIGN_SYSTEM_PATH.exec(requestPath);
    let id: string | null = null;
    if (designSystem && !DESIGN_SYSTEM_PATH_LITERALS.has(designSystem[1]!)) id = safeDecode(designSystem[1]!);
    else if (brand) id = designSystemIdForBrand(safeDecode(brand[1]!) ?? '');
    if (!id) return next();
    const level = access(id);
    if (level === 'none') return sendApiError(res, 404, 'NOT_FOUND', 'Design system not found');
    if (level === 'read' && mutating) {
      return sendApiError(res, 403, 'FORBIDDEN', 'This design system was shared with you to use, not to edit');
    }
    if (level === 'read' && designSystem && !designSystem[2]) {
      interceptJson(res, (body) => (isRecord(body) && body.id === id ? markReadOnly(body) : body));
    }
    return next();
  };
}

// Shared by another user: the web renders it read-only, as it does a design
// system a teammate shared through OpenDesign Cloud.
function markReadOnly(system: Record<string, unknown>): Record<string, unknown> {
  return { ...system, teamSynced: true, canMutate: false };
}

function interceptJson(res: Response, transform: (body: unknown) => unknown): void {
  const json = res.json.bind(res) as Response['json'];
  res.json = ((body: unknown) => json(transform(body))) as Response['json'];
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
