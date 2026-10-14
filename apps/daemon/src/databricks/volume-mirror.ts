import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

// Keeps the daemon data root alive across Databricks Apps redeploys. The app
// container's disk is wiped on every deploy and restart, so the resolved data
// root (RUNTIME_DATA_DIR) is mirrored to a Unity Catalog volume through the
// Files API, as the app's service principal:
//
//   <volume>/od-data/manifest.json   what the mirror holds, written last
//   <volume>/od-data/files/<rel>     one object per data-root file
//
// The local data root stays the only live data root — SQLite and the agents
// need a POSIX disk. The volume is a copy of it, restored once before the
// daemon reads the root and refreshed while it runs.
//
// The invariant that keeps this from destroying data: a manifest is only ever
// published from a data root that was first restored from the manifest it
// replaces. Restore therefore fails closed — when the volume cannot be read,
// the daemon must not start, because a sync from an empty root would publish
// an empty manifest over everyone's projects.

export const VOLUME_MIRROR_DIR = 'od-data';
const MANIFEST_NAME = 'manifest.json';
const FILES_DIR = 'files';
const MANIFEST_VERSION = 1;

// Top-level data-root entries that are diagnostic or rebuilt on demand. They
// are left out of the mirror so it carries only state that cannot be recreated.
const EXCLUDED_TOP_LEVEL = new Set([
  'logs',
  'diagnostics',
  'telemetry',
  'observations',
  'plugin-asset-cache',
  'agent-runtime',
  'sandbox',
]);
// SQLite's side files; databases are mirrored as consistent snapshots instead.
const SQLITE_SIDE_FILE = /-(wal|shm|journal)$/;
const SQLITE_FILE = /\.(sqlite|sqlite3|db)$/;
const UPLOAD_CONCURRENCY = 8;

export interface VolumeMirrorManifestEntry {
  size: number;
  mtimeMs: number;
  /** A database snapshot rather than a byte copy of the file. */
  sqlite?: true;
}

export interface VolumeMirrorManifest {
  version: number;
  updatedAt: string;
  files: Record<string, VolumeMirrorManifestEntry>;
}

export interface VolumeFilesClient {
  /** The object's bytes, or null when it does not exist. */
  download(remotePath: string): Promise<Buffer | null>;
  upload(remotePath: string, body: Buffer): Promise<void>;
  /** Removes the object; a missing object is not an error. */
  remove(remotePath: string): Promise<void>;
}

export class VolumeMirrorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VolumeMirrorError';
  }
}

/**
 * The volume's `/Volumes/<catalog>/<schema>/<volume>` path, from either that
 * path or the `<catalog>.<schema>.<volume>` name a Databricks Apps volume
 * resource may expose. Null when `value` names neither.
 */
export function volumeRootFromEnv(value: string | undefined): string | null {
  const raw = (value ?? '').trim().replace(/\/+$/, '');
  if (raw === '') return null;
  const fromPath = /^\/Volumes\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(raw);
  if (fromPath) return raw;
  const parts = raw.split('.');
  if (parts.length === 3 && parts.every((part) => /^[^/\s]+$/.test(part))) {
    return `/Volumes/${parts.join('/')}`;
  }
  return null;
}

/** Files API client acting with `getToken`'s identity. */
export function createVolumeFilesClient({
  host,
  getToken,
  fetchImpl = fetch,
  timeoutMs = 120_000,
}: {
  host: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): VolumeFilesClient {
  const url = (remotePath: string) =>
    `${host.replace(/\/+$/, '')}/api/2.0/fs/files${remotePath.split('/').map(encodeURIComponent).join('/')}`;
  async function call(method: string, remotePath: string, body?: Buffer): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${await getToken()}` };
    if (body) headers['content-type'] = 'application/octet-stream';
    const target = method === 'PUT' ? `${url(remotePath)}?overwrite=true` : url(remotePath);
    try {
      return await fetchImpl(target, {
        method,
        headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new VolumeMirrorError(
        `${method} ${remotePath} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  async function fail(method: string, remotePath: string, response: Response): Promise<never> {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new VolumeMirrorError(`${method} ${remotePath} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return {
    async download(remotePath) {
      const response = await call('GET', remotePath);
      if (response.status === 404) return null;
      if (!response.ok) return fail('GET', remotePath, response);
      return Buffer.from(await response.arrayBuffer());
    },
    async upload(remotePath, body) {
      const response = await call('PUT', remotePath, body);
      if (!response.ok) await fail('PUT', remotePath, response);
    },
    async remove(remotePath) {
      const response = await call('DELETE', remotePath);
      if (!response.ok && response.status !== 404) await fail('DELETE', remotePath, response);
    },
  };
}

export interface VolumeMirror {
  /**
   * Fill the data root from the volume. Run once, before anything reads the
   * root. Throws when the volume cannot be read; the daemon must not start.
   */
  restore(): Promise<{ restored: number; manifest: boolean }>;
  /** Upload what changed since the last sync and publish a new manifest. */
  sync(): Promise<{ uploaded: number; removed: number }>;
  /** Sync every `intervalMs` until `stop()`, which runs one final sync. */
  start(intervalMs?: number): void;
  stop(): Promise<void>;
}

export function createVolumeMirror({
  dataDir,
  volumeRoot,
  files,
  log = console,
}: {
  dataDir: string;
  volumeRoot: string;
  files: VolumeFilesClient;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}): VolumeMirror {
  const remoteBase = `${volumeRoot}/${VOLUME_MIRROR_DIR}`;
  const manifestPath = `${remoteBase}/${MANIFEST_NAME}`;
  const remoteFile = (rel: string) => `${remoteBase}/${FILES_DIR}/${rel}`;
  // What the volume holds, by data-root-relative path; null until restore()
  // has read it. sync() refuses to run before then (see the invariant above).
  let published: Record<string, VolumeMirrorManifestEntry> | null = null;
  // A database's live signature (its file plus WAL) when it was last
  // snapshotted, so an unchanged database is not snapshotted again.
  const sqliteSignatures = new Map<string, string>();
  let running: Promise<{ uploaded: number; removed: number }> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function readManifest(): Promise<VolumeMirrorManifest | null> {
    const body = await files.download(manifestPath);
    if (!body) return null;
    let parsed: VolumeMirrorManifest;
    try {
      parsed = JSON.parse(body.toString('utf8')) as VolumeMirrorManifest;
    } catch {
      throw new VolumeMirrorError(`${manifestPath} is not valid JSON`);
    }
    if (parsed?.version !== MANIFEST_VERSION || typeof parsed.files !== 'object' || parsed.files === null) {
      throw new VolumeMirrorError(`${manifestPath} has an unsupported format`);
    }
    return parsed;
  }

  async function restore() {
    const manifest = await readManifest();
    if (!manifest) {
      published = {};
      log.info(`[volume-mirror] ${remoteBase} holds no data yet; starting with the local data root`);
      return { restored: 0, manifest: false };
    }
    const entries = Object.entries(manifest.files);
    await forEachLimited(entries, UPLOAD_CONCURRENCY, async ([rel, entry]) => {
      const local = localPath(dataDir, rel);
      const body = await files.download(remoteFile(rel));
      if (!body) throw new VolumeMirrorError(`${remoteFile(rel)} is listed in the manifest but missing`);
      await fs.mkdir(path.dirname(local), { recursive: true });
      // A snapshot replaces the database whole, so stale side files from the
      // container image must not be replayed onto it.
      if (entry.sqlite) {
        await Promise.all(['-wal', '-shm', '-journal'].map((suffix) => fs.rm(`${local}${suffix}`, { force: true })));
      }
      await fs.writeFile(local, body);
      // Keep the recorded mtime so the first sync sees the file as unchanged.
      const mtime = new Date(entry.mtimeMs);
      await fs.utimes(local, mtime, mtime);
    });
    published = { ...manifest.files };
    log.info(`[volume-mirror] restored ${entries.length} file(s) from ${remoteBase}`);
    return { restored: entries.length, manifest: true };
  }

  async function syncOnce() {
    if (!published) throw new VolumeMirrorError('sync() before restore(): refusing to publish an unrestored data root');
    const local = await scan(dataDir);
    const next: Record<string, VolumeMirrorManifestEntry> = {};
    let uploaded = 0;
    const work: Array<() => Promise<void>> = [];
    for (const [rel, stat] of local) {
      const previous = published[rel];
      if (SQLITE_FILE.test(rel)) {
        const signature = await sqliteSignature(path.join(dataDir, rel), stat);
        if (previous?.sqlite && sqliteSignatures.get(rel) === signature) {
          next[rel] = previous;
          continue;
        }
        // Restored but not yet changed: the file on disk is the snapshot.
        if (previous?.sqlite && !sqliteSignatures.has(rel) && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
          sqliteSignatures.set(rel, signature);
          next[rel] = previous;
          continue;
        }
        work.push(async () => {
          const snapshot = await snapshotSqlite(path.join(dataDir, rel));
          await files.upload(remoteFile(rel), snapshot);
          sqliteSignatures.set(rel, signature);
          next[rel] = { size: snapshot.length, mtimeMs: stat.mtimeMs, sqlite: true };
          uploaded += 1;
        });
        continue;
      }
      if (previous && !previous.sqlite && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
        next[rel] = previous;
        continue;
      }
      work.push(async () => {
        let body: Buffer;
        try {
          body = await fs.readFile(path.join(dataDir, rel));
        } catch {
          return; // Removed since the scan; the next sync settles it.
        }
        await files.upload(remoteFile(rel), body);
        next[rel] = { size: stat.size, mtimeMs: stat.mtimeMs };
        uploaded += 1;
      });
    }
    await forEachLimited(work, UPLOAD_CONCURRENCY, (task) => task());
    const gone = Object.keys(published).filter((rel) => !(rel in next));
    if (uploaded === 0 && gone.length === 0) return { uploaded: 0, removed: 0 };
    // The manifest goes up only after every object it names, so a manifest on
    // the volume never points at an object that was not written.
    const manifest: VolumeMirrorManifest = { version: MANIFEST_VERSION, updatedAt: new Date().toISOString(), files: next };
    await files.upload(manifestPath, Buffer.from(JSON.stringify(manifest)));
    published = next;
    await forEachLimited(gone, UPLOAD_CONCURRENCY, async (rel) => {
      await files.remove(remoteFile(rel));
      sqliteSignatures.delete(rel);
    });
    return { uploaded, removed: gone.length };
  }

  function sync() {
    running ??= syncOnce().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    restore,
    sync,
    start(intervalMs = 30_000) {
      if (timer) return;
      timer = setInterval(() => {
        sync().catch((error: unknown) => {
          log.error('[volume-mirror] sync failed; retrying next interval', error);
        });
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running?.catch(() => undefined);
      try {
        const result = await sync();
        log.info(`[volume-mirror] final sync uploaded ${result.uploaded}, removed ${result.removed}`);
      } catch (error) {
        log.error('[volume-mirror] final sync failed', error);
      }
    },
  };
}

/**
 * The mirror named by `OD_DATA_VOLUME` (a Databricks Apps volume resource), or
 * null when it is unset. A set-but-unusable value throws: silently running
 * without the mirror would lose every project at the next deploy.
 */
export function volumeMirrorFromEnv({
  env = process.env,
  dataDir,
  host,
  getServicePrincipalToken,
  fetchImpl,
}: {
  env?: NodeJS.ProcessEnv;
  dataDir: string;
  host: string;
  getServicePrincipalToken: (() => Promise<string>) | null;
  fetchImpl?: typeof fetch;
}): VolumeMirror | null {
  const raw = (env.OD_DATA_VOLUME ?? '').trim();
  if (raw === '') return null;
  const volumeRoot = volumeRootFromEnv(raw);
  if (!volumeRoot) {
    throw new VolumeMirrorError(
      `OD_DATA_VOLUME=${raw} is neither /Volumes/<catalog>/<schema>/<volume> nor <catalog>.<schema>.<volume>`,
    );
  }
  if (!getServicePrincipalToken) {
    throw new VolumeMirrorError(
      'OD_DATA_VOLUME needs the app service principal (DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET)',
    );
  }
  return createVolumeMirror({
    dataDir,
    volumeRoot,
    files: createVolumeFilesClient({ host, getToken: getServicePrincipalToken, ...(fetchImpl ? { fetchImpl } : {}) }),
  });
}

function localPath(dataDir: string, rel: string): string {
  const target = path.resolve(dataDir, rel);
  const inside = path.relative(path.resolve(dataDir), target);
  if (rel.includes('\\') || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new VolumeMirrorError(`manifest path ${rel} escapes the data root`);
  }
  return target;
}

async function scan(dataDir: string): Promise<Map<string, { size: number; mtimeMs: number }>> {
  const out = new Map<string, { size: number; mtimeMs: number }>();
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') await walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile() && !SQLITE_SIDE_FILE.test(entry.name)) {
        try {
          const stat = await fs.stat(path.join(dir, entry.name));
          out.set(rel, { size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) });
        } catch {
          // Removed mid-scan.
        }
      }
    }
  }
  await walk(dataDir, '');
  return out;
}

async function sqliteSignature(file: string, stat: { size: number; mtimeMs: number }): Promise<string> {
  const wal = await fs.stat(`${file}-wal`).catch(() => null);
  return `${stat.size}:${stat.mtimeMs}:${wal ? `${wal.size}:${Math.trunc(wal.mtimeMs)}` : '-'}`;
}

/** A transactionally consistent copy of a live (possibly WAL-mode) database. */
async function snapshotSqlite(file: string): Promise<Buffer> {
  const tmp = path.join(
    os.tmpdir(),
    `od-volume-mirror-${createHash('sha1').update(file).digest('hex').slice(0, 12)}-${process.pid}.sqlite`,
  );
  const source = new Database(file, { readonly: true, fileMustExist: true });
  try {
    await source.backup(tmp);
  } finally {
    source.close();
  }
  try {
    return await fs.readFile(tmp);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]!;
      index += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
