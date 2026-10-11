// Embedded SQLite for the daemon's LOCAL side files.
//
// The daemon's relational state lives in Postgres (storage/postgres/). A few
// files are deliberately separate and local: the diagnostics and telemetry
// outboxes (evidence queues kept apart from the application database so
// fault delivery never couples to it) and reads of external tools' own
// SQLite files (Codex's state DB). Those use Node's built-in `node:sqlite`
// through this thin wrapper, which keeps the better-sqlite3 call shapes they
// were written against (`pragma`, `transaction`, Buffer BLOBs, plain rows).

import { statSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

type AnyFn = (...args: any[]) => any;
type Bindable = null | number | bigint | string | Uint8Array;

export interface LocalSqliteOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  /** Busy timeout in milliseconds. */
  timeout?: number;
}

function reviveRow(row: unknown): any {
  if (!row || typeof row !== 'object') return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Uint8Array && !Buffer.isBuffer(value)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : value;
  }
  return out;
}

function bindArgs(args: unknown[]): Bindable[] {
  return args.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value as Bindable;
  });
}

export class LocalSqliteStatement {
  constructor(private readonly statement: StatementSync) {}

  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    const result = this.statement.run(...bindArgs(args));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get(...args: unknown[]): any {
    return reviveRow(this.statement.get(...bindArgs(args)));
  }

  all(...args: unknown[]): any[] {
    return this.statement.all(...bindArgs(args)).map(reviveRow);
  }
}

export class LocalSqliteDatabase {
  readonly name: string;
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(file: string, options: LocalSqliteOptions = {}) {
    if (options.fileMustExist && file !== ':memory:') {
      // Fail like better-sqlite3's fileMustExist instead of creating the file.
      statSync(file);
    }
    this.name = file;
    this.db = new DatabaseSync(file, {
      readOnly: options.readonly === true,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    });
  }

  get open(): boolean {
    return this.db.isOpen;
  }

  prepare(sql: string): LocalSqliteStatement {
    return new LocalSqliteStatement(this.db.prepare(sql));
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  pragma(statement: string): void {
    this.db.exec(`PRAGMA ${statement}`);
  }

  transaction<F extends AnyFn>(fn: F): F & { immediate: F; deferred: F; exclusive: F } {
    const wrap = (begin: string): F => ((...args: unknown[]) => {
      const savepoint = `local_tx_${this.depth}`;
      const outer = this.depth === 0;
      this.db.exec(outer ? begin : `SAVEPOINT ${savepoint}`);
      this.depth += 1;
      try {
        const result = fn(...args);
        this.depth -= 1;
        this.db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.depth -= 1;
        this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      }
    }) as F;
    return Object.assign(wrap('BEGIN'), {
      deferred: wrap('BEGIN DEFERRED'),
      immediate: wrap('BEGIN IMMEDIATE'),
      exclusive: wrap('BEGIN EXCLUSIVE'),
    });
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
