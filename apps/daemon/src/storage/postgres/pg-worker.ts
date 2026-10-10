// pg worker thread: owns every node-postgres connection for this process.
//
// The daemon's data layer is synchronous (it grew up on better-sqlite3), while
// node-postgres is asynchronous. sql-database.ts bridges the two: the main
// thread posts one request at a time on a MessagePort and blocks on a shared
// Int32 with Atomics.wait; this worker runs the query on the handle's
// dedicated pg.Client, posts the reply, and flips the flag. One client per
// handle keeps SQLite's single-connection semantics (transactions, ordering).
//
// Loaded directly by Node (no build-time import rewriting), so it imports only
// packages and builtins; the credential module URL arrives via workerData.

import { workerData, type MessagePort } from 'node:worker_threads';
import pg from 'pg';

// Mirror better-sqlite3's JS value shapes: 64-bit integers and NUMERIC come
// back as numbers (timestamps are epoch ms, well inside 2^53), and boolean
// expression results come back as 0/1 the way SQLite reports them.
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));
pg.types.setTypeParser(1700, (value: string) => Number(value));
pg.types.setTypeParser(16, (value: string) => (value === 't' ? 1 : 0));
// json/jsonb values stay text, as SQLite's JSON functions return them.
pg.types.setTypeParser(114, (value: string) => value);
pg.types.setTypeParser(3802, (value: string) => value);

interface WorkerInit {
  port: MessagePort;
  signal: SharedArrayBuffer;
  credentialModuleUrl: string;
}

interface ConnConfig {
  kind: 'url' | 'postgres' | 'lakebase';
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  sslMode?: 'disable' | 'prefer' | 'require' | 'verify-full';
  schema: string | null;
  lakebase?: Record<string, unknown>;
  lockTimeoutMs?: number;
}

type Request =
  | { id: number; op: 'open'; handle: number; config: ConnConfig; createSchema: boolean }
  | { id: number; op: 'query'; handle: number; sql: string; params: unknown[]; savepoint: boolean }
  | { id: number; op: 'exec'; handle: number; sql: string }
  | { id: number; op: 'close'; handle: number };

interface Handle {
  config: ConnConfig;
  client: pg.Client | null;
  /** Statement text -> server-side prepared statement name, per connection. */
  statements: Map<string, string>;
  connectedAt: number;
  broken: boolean;
  inTransaction: boolean;
  password: (() => Promise<string>) | null;
}

// Reconnect idle (non-transactional) connections this often so a connection
// authenticated with a short-lived Lakebase credential is never held forever.
const MAX_CONNECTION_AGE_MS = 45 * 60_000;
// Named (server-side prepared) statements skip a Parse round per execution.
// Statement texts are mostly static, but some embed generated IN-lists, so
// cap how many a connection prepares and run the rest unnamed.
const MAX_PREPARED_PER_CONNECTION = 2000;
// SQLSTATE 0A000: "cached plan must not change result type" after DDL.
const PLAN_INVALIDATED = '0A000';
let statementCounter = 0;

const init = workerData as WorkerInit;
const flag = new Int32Array(init.signal);
const handles = new Map<number, Handle>();
let credentialModule: Promise<{
  createLakebasePasswordProvider: (config: unknown) => () => Promise<string>;
}> | null = null;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sslOption(mode: ConnConfig['sslMode']): pg.ClientConfig['ssl'] | undefined {
  if (!mode || mode === 'disable') return false;
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  // 'require' / 'prefer': encrypt without CA pinning, like libpq's sslmode=require.
  return { rejectUnauthorized: false };
}

async function connect(handle: Handle): Promise<pg.Client> {
  const { config } = handle;
  const options: pg.ClientConfig = {};
  if (config.connectionString) options.connectionString = config.connectionString;
  if (config.host) options.host = config.host;
  if (config.port) options.port = config.port;
  if (config.database) options.database = config.database;
  if (config.user) options.user = config.user;
  if (config.password) options.password = config.password;
  const ssl = sslOption(config.sslMode);
  if (ssl !== undefined && (config.sslMode || !config.connectionString)) options.ssl = ssl;
  if (config.kind === 'lakebase') {
    if (!handle.password) {
      credentialModule ??= import(init.credentialModuleUrl);
      const mod = await credentialModule;
      handle.password = mod.createLakebasePasswordProvider(config.lakebase);
    }
    options.password = handle.password;
  }
  const client = new pg.Client(options);
  client.on('error', () => {
    handle.broken = true;
  });
  await client.connect();
  if (config.schema) {
    await client.query(`SET search_path TO ${quoteIdent(config.schema)}`);
  }
  if (typeof config.lockTimeoutMs === 'number') {
    await client.query(`SET lock_timeout = ${Math.trunc(config.lockTimeoutMs)}`);
  }
  handle.client = client;
  handle.statements = new Map();
  handle.connectedAt = Date.now();
  handle.broken = false;
  return client;
}

async function clientFor(handle: Handle): Promise<pg.Client> {
  const stale = handle.client
    && !handle.inTransaction
    && (handle.broken || Date.now() - handle.connectedAt > MAX_CONNECTION_AGE_MS);
  if (stale) {
    const old = handle.client;
    handle.client = null;
    old?.end().catch(() => {});
  }
  if (handle.client) {
    if (handle.broken) throw new Error('postgres connection lost inside a transaction');
    return handle.client;
  }
  return connect(handle);
}

function toBuffer(value: unknown): unknown {
  // Structured clone turns Buffers into plain Uint8Arrays; pg wants Buffers.
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

function trackTransaction(handle: Handle, sql: string): void {
  const head = sql.trimStart().slice(0, 12).toUpperCase();
  if (head.startsWith('BEGIN')) handle.inTransaction = true;
  else if (head.startsWith('COMMIT') || (head.startsWith('ROLLBACK') && !head.startsWith('ROLLBACK TO'))) {
    handle.inTransaction = false;
  }
}

async function handle(request: Request): Promise<unknown> {
  if (request.op === 'open') {
    const entry: Handle = {
      config: request.config,
      client: null,
      statements: new Map(),
      connectedAt: 0,
      broken: false,
      inTransaction: false,
      password: null,
    };
    handles.set(request.handle, entry);
    if (request.createSchema && request.config.schema) {
      // Create the schema on a schema-less connection first: search_path to a
      // missing schema is legal but every unqualified CREATE would then fail.
      const bootstrap: Handle = { ...entry, config: { ...request.config, schema: null } };
      const client = await connect(bootstrap);
      try {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(request.config.schema)}`);
      } catch (error) {
        // Two processes racing to create the same schema: the loser sees a
        // unique violation on pg_namespace and the schema exists either way.
        if ((error as { code?: string }).code !== '23505') throw error;
      } finally {
        await client.end().catch(() => {});
      }
      entry.password = bootstrap.password;
    }
    await clientFor(entry);
    return null;
  }
  const entry = handles.get(request.handle);
  if (!entry) throw new Error(`database handle ${request.handle} is not open`);
  if (request.op === 'close') {
    handles.delete(request.handle);
    await entry.client?.end().catch(() => {});
    entry.client = null;
    return null;
  }
  const client = await clientFor(entry);
  if (request.op === 'exec') {
    await client.query(request.sql);
    trackTransaction(entry, request.sql);
    return null;
  }
  const params = request.params.map(toBuffer);
  if (!request.savepoint) {
    const result = await runStatement(entry, client, request.sql, params, true);
    trackTransaction(entry, request.sql);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }
  // Inside a transaction a failed statement must not poison the whole
  // transaction (SQLite rolls back only the statement), so each statement
  // runs under its own savepoint.
  await client.query('SAVEPOINT od_stmt');
  try {
    const result = await runStatement(entry, client, request.sql, params, false);
    await client.query('RELEASE SAVEPOINT od_stmt');
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT od_stmt').catch(() => {});
    await client.query('RELEASE SAVEPOINT od_stmt').catch(() => {});
    throw error;
  }
}

function statementName(entry: Handle, sql: string): string | undefined {
  let name = entry.statements.get(sql);
  if (!name && entry.statements.size < MAX_PREPARED_PER_CONNECTION) {
    name = `od_s${++statementCounter}`;
    entry.statements.set(sql, name);
  }
  return name;
}

async function runStatement(
  entry: Handle,
  client: pg.Client,
  sql: string,
  params: unknown[],
  mayRetry: boolean,
): Promise<pg.QueryResult> {
  const name = statementName(entry, sql);
  try {
    return await client.query(name ? { name, text: sql, values: params } : { text: sql, values: params });
  } catch (error) {
    if ((error as { code?: string }).code !== PLAN_INVALIDATED || !name) throw error;
    // A table this statement reads changed shape since it was prepared;
    // prepare it again under a fresh name.
    entry.statements.delete(sql);
    if (!mayRetry) throw error;
    return client.query({ text: sql, values: params });
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  const e = error as Record<string, unknown> & { message?: unknown };
  const out: Record<string, unknown> = {
    message: error instanceof Error ? error.message : String(error),
  };
  for (const key of ['code', 'detail', 'hint', 'constraint', 'table', 'column', 'schema', 'severity', 'position']) {
    if (e && e[key] !== undefined) out[key] = e[key];
  }
  return out;
}

let queue: Promise<void> = Promise.resolve();

init.port.on('message', (request: Request) => {
  queue = queue.then(async () => {
    let reply: { id: number; ok: true; value: unknown } | { id: number; ok: false; error: unknown };
    try {
      reply = { id: request.id, ok: true, value: await handle(request) };
    } catch (error) {
      reply = { id: request.id, ok: false, error: serializeError(error) };
    }
    init.port.postMessage(reply);
    Atomics.store(flag, 0, request.id);
    Atomics.notify(flag, 0);
  });
});
