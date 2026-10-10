// Postgres handles for daemon tests.
//
// `createTestDatabase()` replaces the old `new Database(':memory:')` fixture:
// a fresh, fully migrated schema on the suite's Postgres (see
// tests/global-setup-postgres.ts), dropped again by `close()`.
//
// `openDataDirDatabase(dataDir)` opens a second handle onto the schema that
// `openDatabase(..., { dataDir })` uses for that daemon data root (the old
// `new Database(path.join(dataDir, 'app.sqlite'))`), e.g. to inspect what a
// spawned daemon wrote.

import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db.js';
import { resolveDaemonDbConfig, resolveDaemonDbConfigForDataDir } from '../../src/storage/daemon-db.js';
import { SqlDatabase } from '../../src/storage/postgres/sql-database.js';

export interface TestDatabaseOptions {
  /** Apply the daemon migrations (default true). */
  migrate?: boolean;
}

const TEST_SCHEMAS = Symbol.for('open-design.daemon.testSchemas');

/** Schemas created by createTestDatabase in this process (dropped by tests/setup.ts). */
function testSchemaRegistry(): Set<string> {
  const state = globalThis as typeof globalThis & { [TEST_SCHEMAS]?: Set<string> };
  state[TEST_SCHEMAS] ??= new Set();
  return state[TEST_SCHEMAS];
}

export function createTestDatabase(options: TestDatabaseOptions = {}): SqlDatabase {
  const schema = `od_t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  testSchemaRegistry().add(schema);
  const config = { ...resolveDaemonDbConfig(), schema };
  const db = new SqlDatabase({ config, name: `test:${schema}` });
  if (options.migrate !== false) migrate(db);
  const close = db.close.bind(db);
  // Drop the throwaway schema with the handle so a long run does not pile up
  // thousands of schemas in the shared test database.
  db.close = () => {
    if (!db.open) return db;
    try {
      db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      testSchemaRegistry().delete(schema);
    } catch {
      // Best effort: the cluster is disposable.
    }
    return close();
  };
  return db;
}

export function openDataDirDatabase(dataDir: string): SqlDatabase {
  const config = resolveDaemonDbConfigForDataDir(dataDir, {
    ...process.env,
    OD_PG_SCHEMA_PER_DATA_DIR: '1',
  });
  return new SqlDatabase({ config, name: `data-dir:${config.schema}` });
}

/** True when `table` exists in the handle's schema (the old sqlite_master probe). */
export function tableExists(db: SqlDatabase, table: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?`,
  ).get(table));
}

/** Column names of `table`, in order (the old `PRAGMA table_info`). */
export function tableColumns(db: SqlDatabase, table: string): string[] {
  return (db.prepare(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?
      ORDER BY ordinal_position`,
  ).all(table) as Array<{ name: string }>).map((row) => row.name);
}

/**
 * Hold an EXCLUSIVE (write-blocking, read-allowing) lock on `table` from a
 * second connection, the Postgres
 * stand-in for a second SQLite writer holding `BEGIN IMMEDIATE`. Statements
 * on the daemon handle then fail once they exceed its lock timeout (set
 * OD_PG_LOCK_TIMEOUT_MS low before opening it). `exec('ROLLBACK')` releases.
 */
export function holdTableLock(dataDir: string, table: string): SqlDatabase {
  const blocker = openDataDirDatabase(dataDir);
  blocker.exec('BEGIN');
  blocker.exec(`LOCK TABLE "${table}" IN EXCLUSIVE MODE`);
  return blocker;
}

/**
 * Row trigger running plpgsql `body` when `condition` holds (default always)
 * for `event`, e.g. `AFTER UPDATE OF events_json ON messages`. The Postgres
 * stand-in for SQLite's `CREATE TRIGGER ... [WHEN ...] BEGIN ... END`.
 */
export function createRowTrigger(
  db: SqlDatabase,
  input: { name: string; event: string; condition?: string; body: string },
): void {
  const table = /\bON\s+("?[\w.]+"?)/i.exec(input.event)?.[1];
  if (!table) throw new Error(`createRowTrigger: no table in "${input.event}"`);
  db.exec(`
    CREATE OR REPLACE FUNCTION "${input.name}_fn"() RETURNS trigger LANGUAGE plpgsql AS $od_trigger$
    BEGIN
      IF ${input.condition ?? 'TRUE'} THEN
        ${input.body}
      END IF;
      RETURN COALESCE(NEW, OLD);
    END
    $od_trigger$;
    DROP TRIGGER IF EXISTS "${input.name}" ON ${table};
    CREATE TRIGGER "${input.name}" ${input.event}
      FOR EACH ROW EXECUTE FUNCTION "${input.name}_fn"();
  `);
}

/**
 * Failure injection: make `event` (e.g. `BEFORE INSERT ON projects`) raise
 * `message` for rows matching `condition` (plpgsql, may reference NEW/OLD
 * and use subqueries) — SQLite's `SELECT RAISE(ABORT, message)` trigger.
 */
export function createAbortTrigger(
  db: SqlDatabase,
  input: { name: string; event: string; condition?: string; message: string },
): void {
  const literal = `'${input.message.replace(/'/g, "''")}'`;
  createRowTrigger(db, {
    name: input.name,
    event: input.event,
    ...(input.condition ? { condition: input.condition } : {}),
    body: `RAISE EXCEPTION '%', ${literal};`,
  });
}

export function dropRowTrigger(db: SqlDatabase, name: string, table: string): void {
  db.exec(`DROP TRIGGER IF EXISTS "${name}" ON ${table}; DROP FUNCTION IF EXISTS "${name}_fn"();`);
}
