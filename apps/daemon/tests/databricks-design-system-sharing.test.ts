import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attributeNewDesignSystems,
  backingDesignSystemId,
  createDesignSystemSharing,
  createDesignSystemSharingMiddleware,
  designSystemAccess,
} from '../src/databricks/design-system-sharing.js';
import { runAsDatabricksUser } from '../src/databricks/project-ownership.js';
import { bindDatabricksRequestContext } from '../src/databricks/request-context.js';
import { onUserDesignSystemCreated } from '../src/design-systems/created-events.js';
import { createUserDesignSystem, deleteUserDesignSystem, listDesignSystems } from '../src/design-systems/index.js';

let root: string;
let stopListening: (() => void) | null = null;
let close: (() => Promise<unknown>) | null = null;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'od-dbx-ds-'));
});

afterEach(async () => {
  stopListening?.();
  stopListening = null;
  await close?.();
  close = null;
  await rm(root, { recursive: true, force: true });
});

function sharingFor(dir: string) {
  const sharing = createDesignSystemSharing(new Database(':memory:'));
  attributeNewDesignSystems(sharing, dir, (listener) => {
    stopListening = onUserDesignSystemCreated(listener);
  });
  return sharing;
}

const create = (user: string | null, title: string) => {
  const run = () => createUserDesignSystem(root, { title, body: `# ${title}\n` });
  return user ? runAsDatabricksUser(user, run) : run();
};

describe('design-system ownership', () => {
  it('records the signed-in creator of a design system, private until shared', async () => {
    const sharing = sharingFor(root);
    const created = await create('alice', 'Acme');
    expect(created.id).toBe('user:acme');
    expect(sharing.ownerOf('user:acme')).toBe('alice');
    expect(designSystemAccess(sharing, 'user:acme', 'alice')).toBe('write');
    expect(designSystemAccess(sharing, 'user:acme', 'bob')).toBe('none');
    sharing.setShared('user:acme', true);
    expect(designSystemAccess(sharing, 'user:acme', 'bob')).toBe('read');
    // Built-ins and unowned design systems stay open to everyone.
    expect(designSystemAccess(sharing, 'airbnb', 'bob')).toBe('write');
    await create(null, 'Loopback');
    expect(designSystemAccess(sharing, 'user:loopback', 'bob')).toBe('write');
  });

  it('gives a re-created id to its new creator, not the old one', async () => {
    const sharing = sharingFor(root);
    await create('alice', 'Acme');
    sharing.setShared('user:acme', true);
    await deleteUserDesignSystem(root, 'user:acme');
    await create('bob', 'Acme');
    expect(sharing.ownerOf('user:acme')).toBe('bob');
    expect(sharing.isShared('user:acme')).toBe(false);
  });

  it('ignores design systems created under another root', async () => {
    const sharing = sharingFor(path.join(root, 'elsewhere'));
    await create('alice', 'Acme');
    expect(sharing.ownerOf('user:acme')).toBeNull();
  });

  it('finds the design system a project backs', () => {
    expect(backingDesignSystemId({ designSystemId: 'user:a', metadata: { importedFrom: 'design-system' } })).toBe('user:a');
    expect(backingDesignSystemId({
      designSystemId: 'user:a',
      metadata: { importedFrom: 'brand-extraction', brandDesignSystemId: 'user:b' },
    })).toBe('user:b');
    // An ordinary project that merely uses a design system backs none.
    expect(backingDesignSystemId({ designSystemId: 'user:a', metadata: { kind: 'prototype' } })).toBeNull();
    expect(backingDesignSystemId({ designSystemId: 'airbnb', metadata: { importedFrom: 'design-system' } })).toBeNull();
    expect(backingDesignSystemId(null)).toBeNull();
  });
});

// The real middleware and attribution in front of the real design-system
// store, with stand-in routes and a header standing in for the Databricks
// auth middleware's verified user.
async function daemon() {
  const sharing = sharingFor(root);
  const brands = new Map<string, string>([['acme-brand', 'user:acme']]);
  const list = async () =>
    listDesignSystems(root, { idPrefix: 'user:', source: 'user', isEditable: true, defaultStatus: 'draft' });
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    const user = req.get('x-test-user');
    if (!user) return next();
    bindDatabricksRequestContext(req, { user: { id: user } as never, accessToken: 't' });
    runAsDatabricksUser(user, next);
  });
  app.use('/api', createDesignSystemSharingMiddleware({
    sharing,
    listUserDesignSystemIds: async () => (await list()).map((system) => system.id),
    designSystemIdForBrand: (brandId) => brands.get(brandId) ?? null,
  }));
  app.post('/api/design-systems', async (req, res) => {
    res.json({ designSystem: await createUserDesignSystem(root, { title: req.body.title }) });
  });
  app.get('/api/design-systems', async (_req, res) => {
    res.json({ designSystems: [{ id: 'airbnb', source: 'built-in' }, ...(await list()).map(({ id }) => ({ id }))] });
  });
  app.get('/api/design-systems/:id', (req, res) => res.json({ id: req.params.id, title: 'x' }));
  app.patch('/api/design-systems/:id', (req, res) => res.json({ id: req.params.id, updated: true }));
  app.get('/api/brands/:id', (req, res) => res.json({ id: req.params.id }));
  app.delete('/api/brands/:id', (_req, res) => res.json({ ok: true }));
  app.get('/api/workspace/design-systems/team', (_req, res) => res.json({ ids: ['cloud-only'] }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (user: string | null, method: string, url: string, body?: unknown) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  close = () => new Promise((resolve) => server.close(resolve));
  return { call };
}

describe('design-system sharing routes', () => {
  it('keeps a new design system private to its creator', async () => {
    const d = await daemon();
    await d.call('alice', 'POST', '/api/design-systems', { title: 'Acme' });

    const ids = async (user: string) =>
      (await d.call(user, 'GET', '/api/design-systems')).body.designSystems.map((system: any) => system.id);
    expect(await ids('alice')).toEqual(['airbnb', 'user:acme']);
    expect(await ids('bob')).toEqual(['airbnb']);
    expect((await d.call('bob', 'GET', '/api/design-systems/user%3Aacme')).status).toBe(404);
    expect((await d.call('bob', 'GET', '/api/brands/acme-brand')).status).toBe(404);
    expect((await d.call('alice', 'GET', '/api/workspace/design-systems/team')).body).toEqual({ ids: [], resources: [] });
  });

  it('shares a design system with every user, read-only, until its owner takes it back', async () => {
    const d = await daemon();
    await d.call('alice', 'POST', '/api/design-systems', { title: 'Acme' });

    expect((await d.call('bob', 'POST', '/api/workspace/design-systems/user%3Aacme/share')).status).toBe(404);
    expect((await d.call('alice', 'POST', '/api/workspace/design-systems/user%3Aacme/share')).body).toEqual({ shared: true, version: 1 });

    expect((await d.call('bob', 'GET', '/api/workspace/design-systems/team')).body).toEqual({
      ids: ['user:acme'],
      resources: [{ id: 'user:acme', canUnshare: false }],
    });
    expect((await d.call('alice', 'GET', '/api/workspace/design-systems/team')).body.resources).toEqual([
      { id: 'user:acme', canUnshare: true },
    ]);
    // Shared with Bob to use: listed and readable, marked read-only for the web.
    const listed = (await d.call('bob', 'GET', '/api/design-systems')).body.designSystems;
    expect(listed).toContainEqual({ id: 'user:acme', teamSynced: true, canMutate: false });
    expect((await d.call('bob', 'GET', '/api/design-systems/user%3Aacme')).body).toEqual({
      id: 'user:acme', title: 'x', teamSynced: true, canMutate: false,
    });
    expect((await d.call('alice', 'GET', '/api/design-systems/user%3Aacme')).body).toEqual({ id: 'user:acme', title: 'x' });
    expect((await d.call('bob', 'GET', '/api/brands/acme-brand')).status).toBe(200);
    // ...but not to edit, delete, or unshare.
    const patch = await d.call('bob', 'PATCH', '/api/design-systems/user%3Aacme', { title: 'Mine now' });
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe('FORBIDDEN');
    expect((await d.call('bob', 'DELETE', '/api/brands/acme-brand')).status).toBe(403);
    expect((await d.call('bob', 'DELETE', '/api/workspace/design-systems/user%3Aacme/share')).status).toBe(403);
    expect((await d.call('alice', 'PATCH', '/api/design-systems/user%3Aacme', {})).status).toBe(200);

    expect((await d.call('alice', 'DELETE', '/api/workspace/design-systems/user%3Aacme/share')).body).toEqual({ unshared: true });
    expect((await d.call('bob', 'GET', '/api/design-systems/user%3Aacme')).status).toBe(404);
  });

  it('lists unowned design systems as shared, and leaves in-container callers alone', async () => {
    const d = await daemon();
    await create(null, 'Legacy');
    expect((await d.call('bob', 'GET', '/api/workspace/design-systems/team')).body).toEqual({
      ids: ['user:legacy'],
      resources: [{ id: 'user:legacy', canUnshare: false }],
    });
    expect((await d.call('bob', 'PATCH', '/api/design-systems/user%3Alegacy', {})).status).toBe(200);
    await d.call('alice', 'POST', '/api/design-systems', { title: 'Acme' });
    expect((await d.call(null, 'GET', '/api/design-systems/user%3Aacme')).status).toBe(200);
    expect((await d.call(null, 'GET', '/api/workspace/design-systems/team')).body).toEqual({ ids: ['cloud-only'] });
  });
});
