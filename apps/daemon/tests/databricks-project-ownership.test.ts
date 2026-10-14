import type { AddressInfo } from 'node:net';

import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attributeNewProjects,
  createProjectOwnership,
  createProjectOwnershipMiddleware,
  projectIdsInRequest,
  redactForUser,
} from '../src/databricks/project-ownership.js';
import { bindDatabricksRequestContext } from '../src/databricks/request-context.js';

// A miniature daemon: the real ownership middleware and attribution hook in
// front of stand-in project routes, with a header standing in for the
// Databricks auth middleware's verified user.
async function daemon() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)');
  const shared = new Set<string>();
  const listeners = new Set<(id: string) => void>();
  const insertProject = (id: string, name: string) => {
    db.prepare('INSERT INTO projects VALUES (?, ?)').run(id, name);
    for (const listener of listeners) listener(id);
  };
  const ownership = createProjectOwnership(db);
  attributeNewProjects(ownership, (listener) => listeners.add(listener));
  const runs = new Map<string, string>();

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    const user = req.get('x-test-user');
    if (user) bindDatabricksRequestContext(req, { user: { id: user } as never, accessToken: 't' });
    next();
  });
  app.use('/api', createProjectOwnershipMiddleware({
    ownership,
    projectExists: (id) => db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) !== undefined,
    isSharedProject: (id) => shared.has(id),
    projectIdForRun: (runId) => runs.get(runId) ?? null,
  }));
  app.post('/api/projects', async (req, res) => {
    // Attribution must survive the route's own awaits.
    await new Promise((resolve) => setTimeout(resolve, 5));
    insertProject(req.body.id, req.body.name);
    res.json({ project: { id: req.body.id } });
  });
  app.get('/api/projects', (_req, res) => {
    res.json({ projects: db.prepare('SELECT id, name FROM projects').all() });
  });
  app.get('/api/projects/:id/files', (req, res) => res.json({ projectId: req.params.id, files: ['index.html'] }));
  app.post('/api/runs', (req, res) => {
    runs.set(`run-${req.body.projectId}`, req.body.projectId);
    res.json({ runId: `run-${req.body.projectId}` });
  });
  app.get('/api/runs', (_req, res) => {
    res.json({
      runs: [...runs.entries()].map(([id, projectId]) => ({ id, projectId })),
      awaitingInputProjectIds: [...runs.values()],
    });
  });
  app.get('/api/runs/:id/events', (req, res) => res.json({ id: req.params.id }));
  app.get('/api/design-systems', (_req, res) => res.json({ designSystems: [{ id: 'shared-ds' }] }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (user: string | null, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, insertProject, shared, close: () => new Promise((resolve) => server.close(resolve)) };
}

let close: (() => Promise<unknown>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

describe('per-user project visibility', () => {
  it('shows each user only the projects they created, and refuses the rest', async () => {
    const d = await daemon();
    close = d.close;
    await d.call('alice', 'POST', '/api/projects', { id: 'a1', name: 'Alice 1' });
    await d.call('bob', 'POST', '/api/projects', { id: 'b1', name: 'Bob 1' });

    expect((await d.call('alice', 'GET', '/api/projects')).body.projects).toEqual([{ id: 'a1', name: 'Alice 1' }]);
    expect((await d.call('bob', 'GET', '/api/projects')).body.projects).toEqual([{ id: 'b1', name: 'Bob 1' }]);

    expect((await d.call('alice', 'GET', '/api/projects/a1/files')).status).toBe(200);
    const denied = await d.call('alice', 'GET', '/api/projects/b1/files');
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe('PROJECT_NOT_FOUND');

    // Starting a run against someone else's project is refused too.
    expect((await d.call('alice', 'POST', '/api/runs', { projectId: 'b1' })).status).toBe(404);
  });

  it('scopes runs: by id, in lists, and in project-id side lists', async () => {
    const d = await daemon();
    close = d.close;
    await d.call('alice', 'POST', '/api/projects', { id: 'a1', name: 'A' });
    await d.call('bob', 'POST', '/api/projects', { id: 'b1', name: 'B' });
    await d.call('alice', 'POST', '/api/runs', { projectId: 'a1' });
    await d.call('bob', 'POST', '/api/runs', { projectId: 'b1' });

    const list = (await d.call('alice', 'GET', '/api/runs')).body;
    expect(list.runs).toEqual([{ id: 'run-a1', projectId: 'a1' }]);
    expect(list.awaitingInputProjectIds).toEqual(['a1']);
    expect((await d.call('alice', 'GET', '/api/runs/run-b1/events')).status).toBe(404);
    expect((await d.call('bob', 'GET', '/api/runs/run-b1/events')).status).toBe(200);
  });

  it('hides projects with no owner from every user, and leaves in-container callers and shared catalogs alone', async () => {
    const d = await daemon();
    close = d.close;
    // Created before ownership existed: no request user to attribute it to.
    d.insertProject('legacy', 'Old project');
    expect((await d.call('alice', 'GET', '/api/projects')).body.projects).toEqual([]);
    expect((await d.call('alice', 'GET', '/api/projects/legacy/files')).status).toBe(404);
    expect((await d.call(null, 'GET', '/api/projects')).body.projects).toEqual([{ id: 'legacy', name: 'Old project' }]);
    expect((await d.call('alice', 'GET', '/api/design-systems')).body.designSystems).toEqual([{ id: 'shared-ds' }]);
  });

  it('keeps design-system projects shared with everyone', async () => {
    const d = await daemon();
    close = d.close;
    await d.call('alice', 'POST', '/api/projects', { id: 'ds-brand', name: 'Brand design system' });
    d.shared.add('ds-brand');
    expect((await d.call('bob', 'GET', '/api/projects/ds-brand/files')).status).toBe(200);
    expect((await d.call('bob', 'GET', '/api/projects')).body.projects).toEqual([{ id: 'ds-brand', name: 'Brand design system' }]);
  });

  it('never lets a second user claim an existing project id', async () => {
    const d = await daemon();
    close = d.close;
    await d.call('alice', 'POST', '/api/projects', { id: 'p', name: 'Alice' });
    expect((await d.call('bob', 'POST', '/api/projects', { id: 'p', name: 'Bob', projectId: 'p' })).status).toBe(404);
  });
});

describe('request and response scoping', () => {
  it('finds project ids in paths, run ids and request fields', () => {
    const runs = (id: string) => (id === 'r1' ? 'p-run' : null);
    expect(projectIdsInRequest({ path: '/api/projects/p%201/files/x' }, runs)).toEqual(['p 1']);
    expect(projectIdsInRequest({ path: '/api/workspaces/w/projects/p2/move' }, runs)).toEqual(['p2']);
    expect(projectIdsInRequest({ path: '/api/runs/r1/cancel' }, runs)).toEqual(['p-run']);
    expect(projectIdsInRequest({ path: '/api/runs/by-plugin-workflow/w' }, runs)).toEqual([]);
    expect(projectIdsInRequest({ path: '/api/chat', body: { projectId: 'p3' }, query: { projectId: 'p4' } }, runs)).toEqual(['p3', 'p4']);
    expect(projectIdsInRequest({ path: '/api/x', body: { projectIds: ['p5', 7, 'p6'] } }, runs)).toEqual(['p5', 'p6']);
  });

  it('withholds a single record of another user\'s project', () => {
    const visible = (id: string) => id === 'mine';
    expect(redactForUser({ projectId: 'theirs', files: [] }, visible)).toBeNull();
    expect(redactForUser({ projectId: 'mine', files: ['a'] }, visible)).toEqual({ projectId: 'mine', files: ['a'] });
    expect(redactForUser({ items: [{ projectId: 'theirs' }, { other: 1 }], tags: ['theirs'] }, visible)).toEqual({
      items: [{ other: 1 }],
      tags: ['theirs'],
    });
  });
});
