// Plan §3.LL1 — verifySqliteIntegrity() pure helper (Postgres constraint check).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from './helpers/test-db.js';
import type { SqlDatabase } from '../src/storage/postgres/sql-database.js';
import { verifySqliteIntegrity } from '../src/storage/db-inspect.js';

let db: SqlDatabase;

beforeEach(() => {
  db = createTestDatabase({ migrate: false });
});

afterEach(() => {
  db.close();
});

describe('verifySqliteIntegrity', () => {
  it('returns ok=true on a healthy fresh DB', () => {
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);`);
    const report = verifySqliteIntegrity({ db });
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.mode).toBe('integrity_check');
  });

  it("honours the --quick flag (mode='quick_check')", () => {
    const report = verifySqliteIntegrity({ db, quick: true });
    expect(report.mode).toBe('quick_check');
    expect(report.ok).toBe(true);
  });

  it('detects foreign keys that are not validated against existing rows', () => {
    // Postgres refuses to insert an orphan under an enforced FK, so the only
    // way a violation exists is a constraint added NOT VALID over bad rows.
    db.exec(`
      CREATE TABLE parents (id BIGINT PRIMARY KEY);
      CREATE TABLE kids    (id BIGINT PRIMARY KEY, parent_id BIGINT);
      INSERT INTO kids (id, parent_id) VALUES (1, 999);
      ALTER TABLE kids ADD CONSTRAINT kids_parent_fk
        FOREIGN KEY (parent_id) REFERENCES parents(id) NOT VALID;
    `);
    const report = verifySqliteIntegrity({ db });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === 'foreign_key')).toBe(true);
    const fk = report.issues.find((i) => i.kind === 'foreign_key');
    expect(fk?.message).toMatch(/kids/);
    expect(fk?.message).toMatch(/parents/);
  });

  it('records elapsedMs + generatedAt', () => {
    const before = Date.now();
    const report = verifySqliteIntegrity({ db });
    const after = Date.now();
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.generatedAt).toBeGreaterThanOrEqual(before);
    expect(report.generatedAt).toBeLessThanOrEqual(after + 50);
  });

  it('returns ok=true when there are tables but no FK violations', () => {
    db.exec(`
      CREATE TABLE a (id BIGINT PRIMARY KEY);
      CREATE TABLE b (id BIGINT PRIMARY KEY, a_id BIGINT REFERENCES a(id));
      INSERT INTO a VALUES (1), (2);
      INSERT INTO b VALUES (1, 1), (2, 2);
    `);
    const report = verifySqliteIntegrity({ db });
    expect(report.ok).toBe(true);
  });
});
