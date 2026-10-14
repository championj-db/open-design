import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createVolumeFilesClient,
  createVolumeMirror,
  volumeMirrorFromEnv,
  volumeRootFromEnv,
  type VolumeFilesClient,
} from '../src/databricks/volume-mirror.js';

const VOLUME = '/Volumes/cat/schema/vol';
const quiet = { info() {}, warn() {}, error() {} };

function memoryVolume() {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  let failReads = false;
  const files: VolumeFilesClient = {
    async download(remotePath) {
      calls.push(`GET ${remotePath}`);
      if (failReads) throw new Error('volume unavailable');
      return objects.get(remotePath) ?? null;
    },
    async upload(remotePath, body) {
      calls.push(`PUT ${remotePath}`);
      objects.set(remotePath, Buffer.from(body));
    },
    async remove(remotePath) {
      calls.push(`DELETE ${remotePath}`);
      objects.delete(remotePath);
    },
  };
  return {
    files,
    objects,
    calls,
    failReads(value: boolean) {
      failReads = value;
    },
  };
}

let roots: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'od-volume-mirror-'));
  roots.push(dir);
  return dir;
}

beforeEach(() => {
  roots = [];
});
afterEach(async () => {
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeFile(root: string, rel: string, content: string) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
}

describe('volume mirror', () => {
  it('round-trips a data root, with a live WAL database, through a fresh container', async () => {
    const volume = memoryVolume();
    const first = await tempRoot();
    await writeFile(first, 'projects/p1/index.html', '<h1>hi</h1>');
    await writeFile(first, 'app-config.json', '{"a":1}');
    await writeFile(first, 'logs/daemon.log', 'noise');
    await writeFile(first, 'agent-runtime/home/cache', 'noise');
    // A live database whose latest rows are still only in the WAL.
    const live = new Database(path.join(first, 'app.sqlite'));
    live.pragma('journal_mode = WAL');
    live.exec('CREATE TABLE projects (id TEXT)');
    live.prepare('INSERT INTO projects VALUES (?)').run('p1');

    const mirror = createVolumeMirror({ dataDir: first, volumeRoot: VOLUME, files: volume.files, log: quiet });
    await mirror.restore();
    expect(await mirror.sync()).toEqual({ uploaded: 3, removed: 0 });
    live.close();

    const stored = [...volume.objects.keys()].sort();
    expect(stored).toEqual([
      `${VOLUME}/od-data/files/app-config.json`,
      `${VOLUME}/od-data/files/app.sqlite`,
      `${VOLUME}/od-data/files/projects/p1/index.html`,
      `${VOLUME}/od-data/manifest.json`,
    ]);

    // A redeploy: an empty disk, restored from the volume.
    const second = await tempRoot();
    const restoredMirror = createVolumeMirror({ dataDir: second, volumeRoot: VOLUME, files: volume.files, log: quiet });
    expect(await restoredMirror.restore()).toEqual({ restored: 3, manifest: true });
    expect(await fs.readFile(path.join(second, 'projects/p1/index.html'), 'utf8')).toBe('<h1>hi</h1>');
    const restored = new Database(path.join(second, 'app.sqlite'), { readonly: true });
    expect(restored.prepare('SELECT id FROM projects').all()).toEqual([{ id: 'p1' }]);
    restored.close();

    // Nothing changed since the restore, so nothing is uploaded again.
    volume.calls.length = 0;
    expect(await restoredMirror.sync()).toEqual({ uploaded: 0, removed: 0 });
    expect(volume.calls.filter((call) => call.startsWith('PUT'))).toEqual([]);
  });

  it('uploads only changed files and removes deleted ones after the new manifest', async () => {
    const volume = memoryVolume();
    const root = await tempRoot();
    await writeFile(root, 'projects/p1/a.html', 'a');
    await writeFile(root, 'projects/p1/b.html', 'b');
    const mirror = createVolumeMirror({ dataDir: root, volumeRoot: VOLUME, files: volume.files, log: quiet });
    await mirror.restore();
    await mirror.sync();

    volume.calls.length = 0;
    await fs.rm(path.join(root, 'projects/p1/b.html'));
    await writeFile(root, 'projects/p1/a.html', 'a, edited');
    expect(await mirror.sync()).toEqual({ uploaded: 1, removed: 1 });
    expect(volume.calls).toEqual([
      `PUT ${VOLUME}/od-data/files/projects/p1/a.html`,
      `PUT ${VOLUME}/od-data/manifest.json`,
      `DELETE ${VOLUME}/od-data/files/projects/p1/b.html`,
    ]);
  });

  it('fails closed: an unreadable volume stops restore, and sync never runs unrestored', async () => {
    const volume = memoryVolume();
    const root = await tempRoot();
    await writeFile(root, 'projects/p1/a.html', 'a');
    const seeded = createVolumeMirror({ dataDir: root, volumeRoot: VOLUME, files: volume.files, log: quiet });
    await seeded.restore();
    await seeded.sync();
    const manifestBefore = volume.objects.get(`${VOLUME}/od-data/manifest.json`)!.toString();

    const empty = await tempRoot();
    const mirror = createVolumeMirror({ dataDir: empty, volumeRoot: VOLUME, files: volume.files, log: quiet });
    volume.failReads(true);
    await expect(mirror.restore()).rejects.toThrow('volume unavailable');
    await expect(mirror.sync()).rejects.toThrow('before restore');
    expect(volume.objects.get(`${VOLUME}/od-data/manifest.json`)!.toString()).toBe(manifestBefore);
  });

  it('refuses a manifest path that escapes the data root', async () => {
    const volume = memoryVolume();
    volume.objects.set(
      `${VOLUME}/od-data/manifest.json`,
      Buffer.from(JSON.stringify({ version: 1, updatedAt: '', files: { '../outside': { size: 1, mtimeMs: 0 } } })),
    );
    volume.objects.set(`${VOLUME}/od-data/files/../outside`, Buffer.from('x'));
    const mirror = createVolumeMirror({ dataDir: await tempRoot(), volumeRoot: VOLUME, files: volume.files, log: quiet });
    await expect(mirror.restore()).rejects.toThrow('escapes the data root');
  });
});

describe('volume mirror configuration', () => {
  it('accepts a volume path or a three-part volume name', () => {
    expect(volumeRootFromEnv('/Volumes/au_pubsec_catalog/opendesign/persistent_storage/')).toBe(
      '/Volumes/au_pubsec_catalog/opendesign/persistent_storage',
    );
    expect(volumeRootFromEnv('au_pubsec_catalog.opendesign.persistent_storage')).toBe(
      '/Volumes/au_pubsec_catalog/opendesign/persistent_storage',
    );
    expect(volumeRootFromEnv('/tmp/data')).toBeNull();
    expect(volumeRootFromEnv('')).toBeNull();
  });

  it('is off when unset and throws when set but unusable', () => {
    const base = { dataDir: '/x', host: 'https://ws', getServicePrincipalToken: async () => 't' };
    expect(volumeMirrorFromEnv({ ...base, env: {} })).toBeNull();
    expect(() => volumeMirrorFromEnv({ ...base, env: { OD_DATA_VOLUME: 'not-a-volume' } })).toThrow('OD_DATA_VOLUME');
    expect(() =>
      volumeMirrorFromEnv({ ...base, getServicePrincipalToken: null, env: { OD_DATA_VOLUME: 'a.b.c' } }),
    ).toThrow('service principal');
  });

  it('talks to the Files API with the service principal token', async () => {
    const requests: Array<{ url: string; method: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, method: init.method!, auth: new Headers(init.headers).get('authorization') });
      if (init.method === 'GET') return new Response('missing', { status: 404 });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const client = createVolumeFilesClient({ host: 'https://ws/', getToken: async () => 'sp-token', fetchImpl });
    expect(await client.download('/Volumes/c/s/v/od-data/a b.json')).toBeNull();
    await client.upload('/Volumes/c/s/v/od-data/x', Buffer.from('1'));
    await client.remove('/Volumes/c/s/v/od-data/x');
    expect(requests).toEqual([
      { url: 'https://ws/api/2.0/fs/files/Volumes/c/s/v/od-data/a%20b.json', method: 'GET', auth: 'Bearer sp-token' },
      { url: 'https://ws/api/2.0/fs/files/Volumes/c/s/v/od-data/x?overwrite=true', method: 'PUT', auth: 'Bearer sp-token' },
      { url: 'https://ws/api/2.0/fs/files/Volumes/c/s/v/od-data/x', method: 'DELETE', auth: 'Bearer sp-token' },
    ]);
  });
});
