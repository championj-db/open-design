// Ordered, tracked schema migrations.
//
// Each migration is an idempotent `up(db)` (CREATE ... IF NOT EXISTS /
// ADD COLUMN IF NOT EXISTS), applied at most once per schema and recorded in
// `od_schema_migrations`. All pending migrations run in ONE transaction under
// a per-schema advisory lock, so two daemon replicas starting together never
// race the DDL and a failed migration leaves the schema untouched (Postgres
// DDL is transactional).
//
// Append new migrations to the end of the list with a new id; never edit or
// reorder an id that has shipped.

import type { SqlDatabase } from './sql-database.js';

export interface Migration {
  id: string;
  up: (db: SqlDatabase) => void;
}

export interface MigrationResult {
  applied: string[];
}

export function runMigrations(db: SqlDatabase, migrations: readonly Migration[]): MigrationResult {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) throw new Error(`duplicate migration id ${migration.id}`);
    seen.add(migration.id);
  }
  const applied: string[] = [];
  db.transaction(() => {
    db.prepare(`SELECT pg_advisory_xact_lock(hashtext('od_schema_migrations:' || current_schema()))`).get();
    db.exec(`
      CREATE TABLE IF NOT EXISTS od_schema_migrations (
        id TEXT COLLATE "C" PRIMARY KEY,
        applied_at BIGINT NOT NULL
      )
    `);
    const done = new Set(
      (db.prepare(`SELECT id FROM od_schema_migrations`).all() as Array<{ id: string }>).map((row) => row.id),
    );
    const record = db.prepare(`INSERT INTO od_schema_migrations (id, applied_at) VALUES (?, ?)`);
    for (const migration of migrations) {
      if (done.has(migration.id)) continue;
      migration.up(db);
      record.run(migration.id, Date.now());
      applied.push(migration.id);
    }
  })();
  return { applied };
}

export function appliedMigrationIds(db: SqlDatabase): string[] {
  const exists = db
    .prepare(`SELECT to_regclass('od_schema_migrations') IS NOT NULL AS present`)
    .get() as { present: number } | undefined;
  if (!exists?.present) return [];
  return (db.prepare(`SELECT id FROM od_schema_migrations ORDER BY applied_at, id`).all() as Array<{ id: string }>)
    .map((row) => row.id);
}
