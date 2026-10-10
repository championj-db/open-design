// Synchronous PostgreSQL handle for the daemon's data layer.
//
// Every store in the daemon was written against better-sqlite3's synchronous
// `prepare(...).run/get/all` + `transaction(fn)` surface, and the HTTP layer,
// the run loop, and the migrations call it inline. `SqlDatabase` keeps that
// surface and executes each statement on PostgreSQL through node-postgres:
// the pg clients live in a worker thread (pg-worker.ts) and the calling
// thread blocks on Atomics.wait until the reply is posted, the same way it
// used to block on SQLite's file I/O. Statements are real parameterized
// Postgres queries; sql-translate.ts maps the placeholder syntax.
//
// Semantics kept from the SQLite handle:
//   - one connection per handle, statements strictly serialized;
//   - transaction(fn) -> BEGIN/COMMIT, nested calls -> SAVEPOINTs, a returned
//     promise is rejected (the work would run outside the transaction);
//     `.immediate()` also takes a per-schema write lock (SQLite's
//     BEGIN IMMEDIATE);
//   - inside a transaction a failing statement rolls back only itself;
//   - BIGINT/NUMERIC read back as numbers and BYTEA as Buffer.

import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DaemonDbConfig } from '../daemon-db.js';
import { translateSql, type TranslatedSql } from './sql-translate.js';

export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SqlStatement<_Params = unknown[], Row = unknown> {
  readonly source: string;
  run(...params: unknown[]): SqlRunResult;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
  iterate(...params: unknown[]): IterableIterator<Row>;
}

type AnyFn = (...args: any[]) => any;
export type SqlTransaction<F extends AnyFn> = F & {
  default: F;
  deferred: F;
  immediate: F;
  exclusive: F;
};

export class SqlError extends Error {
  code: string | undefined;
  detail: string | undefined;
  constraint: string | undefined;
  table: string | undefined;
  constructor(info: Record<string, unknown>, sql: string | null) {
    super(String(info.message ?? 'postgres error'));
    this.name = 'SqlError';
    this.code = typeof info.code === 'string' ? info.code : undefined;
    this.detail = typeof info.detail === 'string' ? info.detail : undefined;
    this.constraint = typeof info.constraint === 'string' ? info.constraint : undefined;
    this.table = typeof info.table === 'string' ? info.table : undefined;
    if (sql && process.env.OD_PG_DEBUG_SQL === '1') {
      this.message += `\n  in: ${sql.replace(/\s+/g, ' ').trim().slice(0, 500)}`;
    }
  }
}

/** Postgres SQLSTATE for unique_violation. */
export const PG_UNIQUE_VIOLATION = '23505';
/** Postgres SQLSTATE class for integrity constraint violations. */
export function isConstraintViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('23');
}

// ---------------------------------------------------------------------------
// Worker bridge (one worker per process, shared by every handle).

// Shared Int32 slots between this thread and the worker.
const SLOT_REPLY = 0; // id of the last request the worker replied to
const SLOT_CANCEL = 1; // id of a request the caller gave up on (cancel it)
const SLOT_HEARTBEAT = 2; // ticks while the worker's event loop is alive

interface Bridge {
  worker: Worker;
  port: MessagePort;
  flag: Int32Array;
  nextId: number;
  generation: number;
  dead: boolean;
}

let bridge: Bridge | null = null;
let bridgeGeneration = 0;
// Handle ids stay unique across bridge restarts.
let nextHandleId = 1;

function moduleSibling(name: string): string {
  // Under vitest this module runs from src/*.ts; from dist/*.js in production.
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), `${name}${path.extname(here) || '.js'}`);
}

function getBridge(): Bridge {
  if (bridge && !bridge.dead) return bridge;
  const signal = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(moduleSibling('pg-worker'), {
    workerData: {
      port: port2,
      signal,
      credentialModuleUrl: pathToFileURL(moduleSibling('lakebase-credentials')).href,
    },
    transferList: [port2],
  });
  worker.unref();
  port1.unref();
  const created: Bridge = {
    worker,
    port: port1,
    flag: new Int32Array(signal),
    nextId: 1,
    generation: ++bridgeGeneration,
    dead: false,
  };
  // Seen whenever this thread is idle; a worker that dies while a caller is
  // blocked is caught by the heartbeat check in waitForReply instead.
  const onGone = () => discardBridge(created);
  worker.once('error', onGone);
  worker.once('exit', onGone);
  bridge = created;
  return created;
}

function discardBridge(target: Bridge): void {
  target.dead = true;
  if (bridge === target) bridge = null;
  // Terminating the thread closes every socket it owns, so the server ends
  // those sessions (rolling back any open transaction).
  target.worker.terminate().catch(() => {});
}

/** True once this process has started the pg worker (opened any handle). */
export function sqlBridgeStarted(): boolean {
  return bridge !== null;
}

function queryTimeoutMs(): number {
  const raw = Number(process.env.OD_PG_QUERY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

/**
 * Server-side statement_timeout for a bridge timeout. It is strictly shorter
 * than the bridge timeout, so Postgres aborts a long statement (and reports
 * that) before the caller could ever be told "timed out" about a statement
 * that is still running and might commit later.
 */
export function statementTimeoutFor(bridgeTimeoutMs: number): number {
  return bridgeTimeoutMs > 20_000 ? bridgeTimeoutMs - 10_000 : Math.max(1, Math.floor(bridgeTimeoutMs / 2));
}

function cancelGraceMs(): number {
  return Math.min(15_000, Math.max(1_000, queryTimeoutMs()));
}

function workerStallMs(): number {
  const raw = Number(process.env.OD_PG_WORKER_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

// OD_PG_TRACE=1 logs every bridged request to stderr (debugging aid).
const traceEnabled = process.env.OD_PG_TRACE === '1';

type WaitOutcome = 'replied' | 'deadline' | 'dead';

/** Block until the worker has replied to `id`, `deadline` passes, or the worker stops ticking. */
function waitForReply(b: Bridge, id: number, deadline: number): WaitOutcome {
  let beat = Atomics.load(b.flag, SLOT_HEARTBEAT);
  let beatSeenAt = Date.now();
  const stallMs = workerStallMs();
  for (;;) {
    const current = Atomics.load(b.flag, SLOT_REPLY);
    if (current >= id) return 'replied';
    const now = Date.now();
    const nextBeat = Atomics.load(b.flag, SLOT_HEARTBEAT);
    if (nextBeat !== beat) {
      beat = nextBeat;
      beatSeenAt = now;
    } else if (now - beatSeenAt > stallMs) {
      return 'dead';
    }
    const remaining = deadline - now;
    if (remaining <= 0) return 'deadline';
    Atomics.wait(b.flag, SLOT_REPLY, current, Math.min(remaining, 250));
  }
}

function takeReply(b: Bridge, id: number, sql: string | null): unknown {
  for (;;) {
    const received = receiveMessageOnPort(b.port);
    if (!received) {
      throw new SqlError({ message: 'postgres worker reply missing' }, sql);
    }
    const reply = received.message as { id: number; ok: boolean; value?: unknown; error?: Record<string, unknown> };
    if (reply.id !== id) continue;
    if (!reply.ok) throw new SqlError(reply.error ?? {}, sql);
    return reply.value;
  }
}

function call(b: Bridge, request: Record<string, unknown>, sql: string | null): unknown {
  const id = b.nextId++;
  if (traceEnabled) {
    const text = String(sql ?? request.sql ?? '').replace(/\s+/g, ' ').slice(0, Number(process.env.OD_PG_TRACE_WIDTH) || 80);
    process.stderr.write(`[pg-trace] ${Date.now()} #${id} ${String(request.op)} h${String(request.handle)} ${text}\n`);
  }
  // Request ids grow monotonically, so the flag only ever moves forward and
  // an abandoned reply can never satisfy a later wait.
  b.port.postMessage({ ...request, id });
  let outcome = waitForReply(b, id, Date.now() + queryTimeoutMs());
  if (outcome === 'deadline') {
    // Do not report a timeout while the statement may still commit: ask the
    // worker to cancel it on the server, then report whatever really happened
    // (an error if the cancel won, the result if it had already finished).
    Atomics.store(b.flag, SLOT_CANCEL, id);
    outcome = waitForReply(b, id, Date.now() + cancelGraceMs());
  }
  if (outcome === 'replied') return takeReply(b, id, sql);
  // The worker is wedged or gone. Kill it so its sessions end on the server
  // (statement_timeout bounds anything still executing there).
  discardBridge(b);
  throw new SqlError({
    code: 'OD_BRIDGE_UNAVAILABLE',
    message: outcome === 'dead'
      ? 'postgres worker stopped responding'
      : `postgres request timed out after ${queryTimeoutMs()}ms and could not be cancelled`,
  }, sql);
}

/** Test hook: make the worker thread crash while a caller is blocked on it. */
export function crashSqlBridgeForTests(): void {
  const b = getBridge();
  call(b, { op: 'crash' }, null);
}

// ---------------------------------------------------------------------------
// Parameter binding.

const translationCache = new Map<string, TranslatedSql>();

function translate(sql: string): TranslatedSql {
  let translated = translationCache.get(sql);
  if (!translated) {
    translated = translateSql(sql);
    if (translationCache.size > 4000) translationCache.clear();
    translationCache.set(sql, translated);
  }
  return translated;
}

function isNamedBag(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Uint8Array)
    && !(value instanceof Date);
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function bindParams(translated: TranslatedSql, args: unknown[]): unknown[] {
  const positional: unknown[] = [];
  let named: Record<string, unknown> | null = null;
  for (const arg of args) {
    if (Array.isArray(arg)) positional.push(...arg);
    else if (isNamedBag(arg)) named = { ...(named ?? {}), ...arg };
    else positional.push(arg);
  }
  if (translated.native) return positional.map(normalizeValue);
  return translated.bindings.map((binding) => {
    if (typeof binding === 'number') {
      if (binding >= positional.length) {
        throw new RangeError(`Too few parameter values were provided (need ${binding + 1})`);
      }
      return normalizeValue(positional[binding]);
    }
    if (!named || !(binding in named)) {
      throw new RangeError(`Missing named parameter "${binding}"`);
    }
    return normalizeValue(named[binding]);
  });
}

function reviveRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
      row[key] = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
  }
  return row;
}

// ---------------------------------------------------------------------------

const WRITE_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('od_write_lock:' || current_schema()))`;

export interface SqlDatabaseOptions {
  config: DaemonDbConfig;
  /** Display label (better-sqlite3's `db.name`). */
  name?: string;
  /** Create `config.schema` if it does not exist. Default true. */
  createSchema?: boolean;
}

export class SqlDatabase {
  readonly name: string;
  readonly config: DaemonDbConfig;
  private readonly handle: number;
  private readonly createSchema: boolean;
  private isOpen = true;
  private txDepth = 0;
  private manualTx = false;
  /** Generation of the bridge this handle's connection lives on. */
  private generation = 0;

  constructor(options: SqlDatabaseOptions) {
    this.handle = nextHandleId++;
    this.config = options.config;
    this.name = options.name ?? 'postgres';
    this.createSchema = options.createSchema !== false;
    this.bridgeFor();
  }

  /**
   * The live bridge, (re)opening this handle's connection on it when the
   * worker was replaced since the handle last used it. A connection lost in
   * the middle of a transaction cannot be resumed, so that surfaces as an
   * error and the transaction state is reset.
   */
  private bridgeFor(): Bridge {
    const b = getBridge();
    if (b.generation === this.generation) return b;
    const lostTransaction = this.generation !== 0 && (this.txDepth > 0 || this.manualTx);
    this.txDepth = 0;
    this.manualTx = false;
    call(b, {
      op: 'open',
      handle: this.handle,
      config: this.config,
      createSchema: this.createSchema,
      statementTimeoutMs: statementTimeoutFor(queryTimeoutMs()),
    }, null);
    this.generation = b.generation;
    if (lostTransaction) {
      throw new SqlError({ code: 'OD_BRIDGE_UNAVAILABLE', message: 'postgres connection lost inside a transaction' }, null);
    }
    return b;
  }

  private send(request: Record<string, unknown>, sql: string | null): unknown {
    return call(this.bridgeFor(), { ...request, handle: this.handle }, sql);
  }

  get open(): boolean {
    return this.isOpen;
  }

  get inTransaction(): boolean {
    return this.txDepth > 0 || this.manualTx;
  }

  get schema(): string | null {
    return this.config.schema;
  }

  private assertOpen(): void {
    if (!this.isOpen) throw new TypeError('The database connection is not open');
  }

  /** Run one statement; returns raw pg rows + rowCount. */
  query(sql: string, args: unknown[] = []): { rows: Record<string, unknown>[]; rowCount: number } {
    this.assertOpen();
    const translated = translate(sql);
    const params = bindParams(translated, args);
    const value = this.send(
      {
        op: 'query',
        sql: translated.text,
        params,
        savepoint: this.inTransaction,
      },
      translated.text,
    ) as { rows: Record<string, unknown>[]; rowCount: number };
    return { rows: value.rows.map(reviveRow), rowCount: value.rowCount };
  }

  prepare<Params = unknown[], Row = unknown>(sql: string): SqlStatement<Params, Row> {
    this.assertOpen();
    // Translate eagerly so malformed placeholder use fails at prepare time.
    translate(sql);
    const run = (args: unknown[]) => this.query(sql, args);
    return {
      source: sql,
      run: (...args: unknown[]) => {
        const result = run(args);
        return { changes: result.rowCount, lastInsertRowid: 0 };
      },
      get: (...args: unknown[]) => run(args).rows[0] as Row | undefined,
      all: (...args: unknown[]) => run(args).rows as Row[],
      iterate: (...args: unknown[]) => (run(args).rows as Row[])[Symbol.iterator](),
    };
  }

  /** Run one or more parameterless statements (simple query protocol). */
  exec(sql: string): this {
    this.assertOpen();
    this.send({ op: 'exec', sql: translate(sql).text }, sql);
    const head = sql.trimStart().slice(0, 12).toUpperCase();
    if (head.startsWith('BEGIN')) this.manualTx = true;
    else if (head.startsWith('COMMIT') || head.startsWith('END') || (head.startsWith('ROLLBACK') && !head.startsWith('ROLLBACK TO'))) {
      this.manualTx = false;
    }
    return this;
  }

  private rollbackQuietly(sql: string): void {
    try {
      this.send({ op: 'exec', sql }, null);
    } catch {
      // The original error is the one worth surfacing.
    }
  }

  transaction<F extends AnyFn>(fn: F): SqlTransaction<F> {
    const wrap = (writeLock: boolean): F => ((...args: unknown[]) => {
      this.assertOpen();
      const depth = this.txDepth;
      const savepoint = `od_tx_${depth}`;
      const outer = depth === 0 && !this.manualTx;
      this.send({ op: 'exec', sql: outer ? 'BEGIN' : `SAVEPOINT ${savepoint}` }, null);
      if (outer && writeLock) {
        // A separate step, so a lock timeout leaves a transaction we can (and
        // always do) roll back instead of an aborted one nobody owns.
        try {
          this.send({ op: 'query', sql: WRITE_LOCK_SQL, params: [], savepoint: false }, WRITE_LOCK_SQL);
        } catch (error) {
          this.rollbackQuietly('ROLLBACK');
          throw error;
        }
      }
      this.txDepth += 1;
      let result: unknown;
      try {
        result = fn(...args);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          throw new TypeError('Transaction function cannot return a promise');
        }
      } catch (error) {
        this.txDepth -= 1;
        this.rollbackQuietly(outer ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
      this.txDepth -= 1;
      this.send({ op: 'exec', sql: outer ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}` }, null);
      return result;
    }) as F;
    const tx = wrap(false) as SqlTransaction<F>;
    tx.default = tx;
    tx.deferred = tx;
    // SQLite's IMMEDIATE/EXCLUSIVE take the database write lock before the
    // first read. The equivalent here is a per-schema transaction-scoped
    // advisory lock, so read-then-write sequences stay serialized across
    // connections (other daemon replicas, a second handle in tests).
    tx.immediate = wrap(true);
    tx.exclusive = tx.immediate;
    return tx;
  }

  close(): this {
    if (!this.isOpen) return this;
    this.isOpen = false;
    const b = bridge;
    if (!b || b.dead || b.generation !== this.generation) return this;
    try {
      call(b, { op: 'close', handle: this.handle }, null);
    } catch {
      // Closing a handle whose connection already died is not an error.
    }
    return this;
  }
}
