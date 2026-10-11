// Vitest global setup: make sure the daemon suite has a Postgres to talk to.
//
// If DATABASE_URL (or PGHOST) is already set, the suite uses that server as-is.
// Otherwise this provisions a throwaway local cluster (initdb + pg_ctl on a
// free port under the OS temp dir), exports DATABASE_URL for the test workers,
// and tears it down after the run. Set OD_TEST_PG_AUTO=0 to skip provisioning.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

function findPgBin(name: string): string | null {
  const fromPath = (process.env.PATH ?? '').split(path.delimiter)
    .map((dir) => path.join(dir, name))
    .find((candidate) => existsSync(candidate));
  if (fromPath) return fromPath;
  const root = '/usr/lib/postgresql';
  if (!existsSync(root)) return null;
  const versions = readdirSync(root).sort((a, b) => Number(b) - Number(a));
  for (const version of versions) {
    const candidate = path.join(root, version, 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export default async function setup(): Promise<(() => void) | void> {
  if (process.env.DATABASE_URL || process.env.PGHOST || process.env.OD_TEST_PG_AUTO === '0') return;
  const initdb = findPgBin('initdb');
  const pgCtl = findPgBin('pg_ctl');
  if (!initdb || !pgCtl) {
    console.warn(
      '[daemon tests] no DATABASE_URL and no local initdb/pg_ctl found; tests that open the ' +
        'daemon database will fail. Install PostgreSQL or set DATABASE_URL.',
    );
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'od-daemon-pg-'));
  const dataDir = path.join(dir, 'data');
  const port = await freePort();
  execFileSync(initdb, ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync'], {
    stdio: 'ignore',
  });
  execFileSync(pgCtl, [
    '-D', dataDir,
    '-l', path.join(dir, 'postgres.log'),
    '-w',
    '-o', [
      `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c max_connections=500`,
      // Disposable cluster: no durability, and keep WAL small so a full run
      // does not fill the disk.
      '-c fsync=off -c synchronous_commit=off -c full_page_writes=off',
      '-c wal_level=minimal -c max_wal_senders=0 -c max_wal_size=64MB -c min_wal_size=32MB',
    ].join(' '),
    'start',
  ], { stdio: 'ignore' });
  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
  return () => {
    try {
      execFileSync(pgCtl, ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
