// Phase 5 / spec §15.6 / plan §3.GG1 — daemon-DB inspection helper.
//
// Pure helper that walks the daemon's Postgres schema and returns a
// structured inventory: on-disk size, table list, per-table row count,
// schema version (the number of applied migrations).
//
// Used by:
//   - `od daemon db status` (CLI ops sanity check),
//   - the `od doctor` aggregator.
//
// Pure relative to its inputs: callers pass the open handle. The function
// never opens a new connection or mutates state. The historical `file`
// input (the SQLite path) is accepted and ignored.

import type { SqlDatabase } from './postgres/sql-database.js';
import { appliedMigrationIds } from './postgres/migrations.js';

type SqliteDb = SqlDatabase;

export interface DaemonDbTableInfo {
  name:      string;
  rowCount:  number;
}

export interface DaemonDbStatusReport {
  kind:           'sqlite' | 'postgres';
  // Connection identifier ('postgres host:port/db as user', no secrets).
  location:       string;
  // Total bytes the daemon schema's tables + indexes + TOAST occupy.
  sizeBytes:      number;
  schemaVersion:  number | null;
  tables:         DaemonDbTableInfo[];
  generatedAt:    number;
}

const SYSTEM_TABLE_PREFIXES = ['od_schema_migrations'];

function isSystemTable(name: string): boolean {
  return SYSTEM_TABLE_PREFIXES.some((p) => name.startsWith(p));
}

const SCHEMA_TABLES_SQL = `
  SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
   ORDER BY c.relname`;

function schemaSizeBytes(db: SqliteDb): number | null {
  const row = db.prepare(`
    SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
  `).get() as { bytes: number } | undefined;
  const bytes = Number(row?.bytes);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

export async function inspectSqliteDatabase(input: {
  db: SqliteDb;
  file?: string;
}): Promise<DaemonDbStatusReport> {
  const { db } = input;

  // 1. Schema version (applied migration count).
  let schemaVersion: number | null = null;
  try {
    schemaVersion = appliedMigrationIds(db).length;
  } catch {
    schemaVersion = null;
  }

  // 2. Table list with row counts.
  const tables: DaemonDbTableInfo[] = [];
  try {
    const names = db.prepare(SCHEMA_TABLES_SQL).all() as Array<{ name: string }>;
    for (const { name } of names) {
      if (isSystemTable(name)) continue;
      try {
        const safe = sanitizeTableName(name);
        if (!safe) continue;
        const row = db.prepare(`SELECT count(*) AS c FROM "${safe}"`).get() as { c: number } | undefined;
        tables.push({ name: safe, rowCount: row?.c ?? 0 });
      } catch {
        // A malformed view / unreadable table shouldn't fail the
        // whole report; record 0 rows.
        tables.push({ name, rowCount: 0 });
      }
    }
  } catch {
    // ignore — empty tables[] surfaces 'cannot read schema' to the
    // caller (CLI shows 0 tables, which is itself a useful signal).
  }

  let sizeBytes = 0;
  try {
    sizeBytes = schemaSizeBytes(db) ?? 0;
  } catch {
    sizeBytes = 0;
  }

  return {
    kind:          'postgres',
    location:      db.name,
    sizeBytes,
    schemaVersion,
    tables,
    generatedAt:   Date.now(),
  };
}

export interface SqlitePageStats {
  pageSize:      number | null;
  pageCount:     number | null;
  freelistCount: number | null;
  // Separate from sizeBytes above: WAL growth and main-file growth mean
  // different things for storage diagnosis. On Postgres the WAL is the
  // server's, not the daemon's, so walBytes is always null.
  mainBytes:     number | null;
  walBytes:      number | null;
}

/**
 * Cheap storage snapshot for observability: catalog reads only (block size
 * and relation sizes), never a table scan, so it is safe to call on startup
 * and under memory pressure. Every field that cannot be read is null, never 0.
 */
export function readSqlitePageStats(input: { db: SqliteDb; file?: string }): SqlitePageStats {
  const { db } = input;
  let pageSize: number | null = null;
  let mainBytes: number | null = null;
  try {
    const row = db.prepare(`SELECT current_setting('block_size')::bigint AS size`).get() as { size: number } | undefined;
    const value = Number(row?.size);
    pageSize = Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    pageSize = null;
  }
  try {
    mainBytes = schemaSizeBytes(db);
  } catch {
    mainBytes = null;
  }
  return {
    pageSize,
    pageCount:     pageSize && mainBytes != null ? Math.ceil(mainBytes / pageSize) : null,
    freelistCount: null,
    mainBytes,
    walBytes:      null,
  };
}

function sanitizeTableName(name: string): string | null {
  // Allow ASCII alphanumerics + underscore; identifier sanity check.
  // Prevents accidental SQL injection if a malicious migration ever
  // invents a hostile table name.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  return name;
}

// Plan §3.LL1 — daemon-DB integrity check.
//
// Postgres keeps its own page-level integrity, so the check here is about
// the daemon's schema: the connection answers, and no foreign key or check
// constraint is left NOT VALID (rows that bypassed the constraint). Both
// modes run the same checks; 'quick_check' is kept for CLI compatibility.

export type DbIntegrityIssueKind = 'integrity' | 'foreign_key';

export interface DbIntegrityIssue {
  kind:    DbIntegrityIssueKind;
  message: string;
}

export interface DbIntegrityReport {
  ok:           boolean;
  // 'integrity_check' (default) or 'quick_check' — quick is faster
  // but skips the index-content check.
  mode:         'integrity_check' | 'quick_check';
  issues:       DbIntegrityIssue[];
  elapsedMs:    number;
  generatedAt:  number;
}

export interface VerifyDbOptions {
  db:    SqliteDb;
  quick?: boolean;
}

export function verifySqliteIntegrity(opts: VerifyDbOptions): DbIntegrityReport {
  const { db, quick = false } = opts;
  const startedAt = Date.now();
  const issues: DbIntegrityIssue[] = [];

  // 1. The connection answers.
  try {
    db.prepare('SELECT 1 AS ok').get();
  } catch (err) {
    issues.push({ kind: 'integrity', message: `connection check threw: ${(err as Error).message}` });
  }

  // 2. Unvalidated constraints.
  try {
    const rows = db.prepare(`
      SELECT con.conname AS name, rel.relname AS "table", con.contype AS type,
             ref.relname AS parent
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
        LEFT JOIN pg_class ref ON ref.oid = con.confrelid
       WHERE n.nspname = current_schema() AND NOT con.convalidated
       ORDER BY rel.relname, con.conname
    `).all() as Array<{ name: string; table: string; type: string; parent: string | null }>;
    for (const row of rows) {
      issues.push(row.type === 'f'
        ? {
            kind: 'foreign_key',
            message: `FK ${row.name} in ${row.table} referencing ${row.parent ?? '?'} is NOT VALID`,
          }
        : { kind: 'integrity', message: `constraint ${row.name} on ${row.table} is NOT VALID` });
    }
  } catch (err) {
    issues.push({ kind: 'foreign_key', message: `constraint check threw: ${(err as Error).message}` });
  }

  return {
    ok:          issues.length === 0,
    mode:        quick ? 'quick_check' : 'integrity_check',
    issues,
    elapsedMs:   Date.now() - startedAt,
    generatedAt: Date.now(),
  };
}
