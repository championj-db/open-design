import { execFileSync } from 'node:child_process';
import { afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonCliDist = path.join(daemonRoot, 'dist', 'cli.js');

function pnpmInvocation(): { args: string[]; command: string } {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /\.(?:cjs|js)$/iu.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath] };
  }
  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: [] };
}

function ensureDaemonCliBuilt() {
  if (existsSync(daemonCliDist)) return;
  const pnpm = pnpmInvocation();
  execFileSync(pnpm.command, [...pnpm.args, 'run', 'build'], {
    cwd: daemonRoot,
    stdio: 'inherit',
    env: process.env,
  });
}

const TEST_DATA_DIR_SYMBOL = Symbol.for('open-design.daemon.vitestDataDir');

const globalState = globalThis as typeof globalThis & {
  [TEST_DATA_DIR_SYMBOL]?: string;
};

if (!globalState[TEST_DATA_DIR_SYMBOL]) {
  globalState[TEST_DATA_DIR_SYMBOL] = mkdtempSync(path.join(tmpdir(), 'od-daemon-vitest-'));

  process.once('exit', () => {
    rmSync(globalState[TEST_DATA_DIR_SYMBOL]!, { force: true, recursive: true });
  });
}

// Server paths are resolved at module import time. Force every daemon test
// process to use one isolated data directory before any test imports server.ts,
// so tests can never read or overwrite the developer's real repo `.od` data.
process.env.OD_DATA_DIR = globalState[TEST_DATA_DIR_SYMBOL];
// The relational store is Postgres (DATABASE_URL / PG* env, provisioned by
// tests/global-setup-postgres.ts when unset). Give every daemon data root its
// own schema so fixtures that open separate data dirs stay isolated, and a
// test that reopens a data dir sees the rows it wrote.
process.env.OD_PG_SCHEMA_PER_DATA_DIR ??= '1';
// Keep unit tests from reading a developer's stored Vela profile and routing
// Langfuse-shaped telemetry through the authenticated Vela sink by accident.
process.env.OPEN_DESIGN_VELA_TELEMETRY ??= 'off';

// Publish/share endpoints shell out through OD_NODE_BIN + OD_BIN (dist/cli.js).
// Build the CLI artifact once per vitest process so package tests do not depend
// on a prior manual `pnpm --filter @open-design/daemon build`.
ensureDaemonCliBuilt();
process.env.OD_DAEMON_CLI_PATH = daemonCliDist;

// Postgres hygiene: drop schemas this file leaked (createTestDatabase handles
// never closed) and per-data-root schemas whose data root is already gone, so
// a full run does not accumulate thousands of schemas in the test cluster.
afterAll(async () => {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return;
  const sql = await import('../src/storage/postgres/sql-database.js');
  if (!sql.sqlBridgeStarted()) return;
  const { DATA_DIR_SCHEMA_COMMENT_PREFIX, resolveDaemonDbConfig } = await import('../src/storage/daemon-db.js');
  const leaked = (globalThis as Record<symbol, Set<string> | undefined>)[Symbol.for('open-design.daemon.testSchemas')];
  let db: InstanceType<typeof sql.SqlDatabase> | null = null;
  try {
    db = new sql.SqlDatabase({ config: { ...resolveDaemonDbConfig(), schema: null }, name: 'test-sweep' });
    const owned = db.prepare(
      `SELECT nspname AS name, obj_description(oid, 'pg_namespace') AS note
         FROM pg_namespace
        WHERE nspname LIKE 'od\\_%'`,
    ).all() as Array<{ name: string; note: string | null }>;
    const drop = new Set(leaked ?? []);
    for (const { name, note } of owned) {
      if (!note?.startsWith(DATA_DIR_SCHEMA_COMMENT_PREFIX)) continue;
      if (!existsSync(note.slice(DATA_DIR_SCHEMA_COMMENT_PREFIX.length))) drop.add(name);
    }
    for (const name of drop) db.exec(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    leaked?.clear();
  } catch {
    // Best effort: the cluster is disposable.
  } finally {
    db?.close();
  }
});
