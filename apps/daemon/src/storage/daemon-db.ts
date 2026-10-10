// Daemon relational-database connection config.
//
// The daemon's relational state lives in PostgreSQL: Databricks Lakebase in
// production (Databricks Apps), any plain Postgres for local dev and CI. The
// backend is selected by env presence:
//
//   1. DATABASE_URL                     -> plain connection string, used as-is.
//   2. LAKEBASE_ENDPOINT                -> Lakebase. Host/db/user from
//      (+ PGHOST or LAKEBASE_HOST)         PGHOST|LAKEBASE_HOST, PGPORT (5432),
//                                          PGDATABASE (databricks_postgres),
//                                          PGUSER|LAKEBASE_USER|DATABRICKS_CLIENT_ID,
//                                          PGSSLMODE (require). The password is a
//                                          short-lived OAuth DB credential minted
//                                          per connection (lakebase-credentials.ts).
//   3. PGHOST (+ optional PGPASSWORD)   -> plain Postgres from libpq-style env.
//
// OD_PG_SCHEMA optionally pins the schema (search_path) the daemon owns;
// it defaults to `public`. OD_PG_SCHEMA_PER_DATA_DIR=1 instead derives the
// schema from the daemon data root, so every isolated data root (test
// fixtures, side-by-side dev daemons) gets isolated relational state. The resolved config is plain data so it can be
// posted to the pg worker thread.

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { LakebaseCredentialConfig } from './postgres/lakebase-credentials.js';

export type DaemonDbKind = 'url' | 'postgres' | 'lakebase';
export type PgSslMode = 'disable' | 'prefer' | 'require' | 'verify-full';

export interface DaemonDbConfig {
  kind: DaemonDbKind;
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /** Static password (PGPASSWORD). Never set for Lakebase. */
  password?: string;
  sslMode?: PgSslMode;
  /** Schema the daemon owns; null means the connection default (public). */
  schema: string | null;
  /** Present only for kind 'lakebase'. */
  lakebase?: LakebaseCredentialConfig;
  /**
   * How long a statement waits for a row/table lock before failing, like
   * better-sqlite3's 5s busy timeout. OD_PG_LOCK_TIMEOUT_MS overrides.
   */
  lockTimeoutMs?: number;
}

export class DaemonDbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonDbConfigError';
  }
}

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseSslMode(value: string | undefined, fallback: PgSslMode): PgSslMode {
  const mode = clean(value)?.toLowerCase();
  if (!mode) return fallback;
  if (mode === 'disable' || mode === 'prefer' || mode === 'require' || mode === 'verify-full') return mode;
  if (mode === 'allow') return 'prefer';
  if (mode === 'verify-ca') return 'verify-full';
  throw new DaemonDbConfigError(
    `unknown PGSSLMODE '${mode}'. Accepted: disable, prefer, require, verify-full.`,
  );
}

/**
 * Lakebase requires TLS, and its password is a live OAuth credential: never
 * let PGSSLMODE downgrade it below `require`.
 */
function lakebaseSslMode(value: string | undefined): PgSslMode {
  const mode = parseSslMode(value, 'require');
  if (mode !== 'require' && mode !== 'verify-full') {
    throw new DaemonDbConfigError(
      `PGSSLMODE '${clean(value)}' is not allowed for Lakebase; use require or verify-full.`,
    );
  }
  return mode;
}

function parsePort(value: string | undefined): number {
  const raw = clean(value);
  if (!raw) return 5432;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new DaemonDbConfigError(`invalid PGPORT '${raw}'.`);
  }
  return port;
}

export function resolveDbSchema(env: Record<string, string | undefined>): string | null {
  const schema = clean(env.OD_PG_SCHEMA);
  if (!schema) return null;
  if (!SCHEMA_NAME.test(schema)) {
    throw new DaemonDbConfigError(`invalid OD_PG_SCHEMA '${schema}': use [A-Za-z_][A-Za-z0-9_]*.`);
  }
  return schema;
}

function parseLockTimeout(value: string | undefined): number {
  const raw = clean(value);
  if (!raw) return 5000;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 0) {
    throw new DaemonDbConfigError(`invalid OD_PG_LOCK_TIMEOUT_MS '${raw}'.`);
  }
  return ms;
}

export function resolveDaemonDbConfig(env?: Record<string, string | undefined>): DaemonDbConfig {
  const e = env ?? process.env;
  const config = resolveConnection(e);
  return { ...config, lockTimeoutMs: parseLockTimeout(e.OD_PG_LOCK_TIMEOUT_MS) };
}

function resolveConnection(e: Record<string, string | undefined>): DaemonDbConfig {
  const schema = resolveDbSchema(e);

  const url = clean(e.DATABASE_URL);
  if (url) {
    const sslMode = clean(e.PGSSLMODE) ? parseSslMode(e.PGSSLMODE, 'disable') : undefined;
    return { kind: 'url', connectionString: url, ...(sslMode ? { sslMode } : {}), schema };
  }

  const host = clean(e.LAKEBASE_HOST) ?? clean(e.PGHOST);
  const endpoint = clean(e.LAKEBASE_ENDPOINT);
  if (endpoint) {
    const user = clean(e.PGUSER) ?? clean(e.LAKEBASE_USER) ?? clean(e.DATABRICKS_CLIENT_ID);
    if (!host || !user) {
      throw new DaemonDbConfigError(
        'LAKEBASE_ENDPOINT is set, so the daemon connects to Lakebase; it also needs ' +
          'PGHOST (or LAKEBASE_HOST) and PGUSER (or LAKEBASE_USER / DATABRICKS_CLIENT_ID).',
      );
    }
    const workspaceHost = clean(e.DATABRICKS_HOST) ?? null;
    const sourceRaw = clean(e.OD_LAKEBASE_CREDENTIAL_SOURCE)?.toLowerCase();
    if (sourceRaw && sourceRaw !== 'rest' && sourceRaw !== 'cli') {
      throw new DaemonDbConfigError(
        `unknown OD_LAKEBASE_CREDENTIAL_SOURCE '${sourceRaw}'. Accepted: rest, cli.`,
      );
    }
    const source = (sourceRaw as 'rest' | 'cli' | undefined) ?? (workspaceHost ? 'rest' : 'cli');
    return {
      kind: 'lakebase',
      host,
      port: parsePort(e.PGPORT),
      database: clean(e.PGDATABASE) ?? 'databricks_postgres',
      user,
      sslMode: lakebaseSslMode(e.PGSSLMODE),
      schema,
      lakebase: {
        source,
        endpoint,
        workspaceHost,
        workspaceToken: clean(e.DATABRICKS_TOKEN) ?? null,
        clientId: clean(e.DATABRICKS_CLIENT_ID) ?? null,
        clientSecret: clean(e.DATABRICKS_CLIENT_SECRET) ?? null,
        cliPath: clean(e.OD_DATABRICKS_CLI) ?? 'databricks',
        cliProfile: clean(e.DATABRICKS_CONFIG_PROFILE) ?? null,
      },
    };
  }

  if (host) {
    const password = e.PGPASSWORD;
    return {
      kind: 'postgres',
      host,
      port: parsePort(e.PGPORT),
      database: clean(e.PGDATABASE) ?? clean(e.PGUSER) ?? 'postgres',
      user: clean(e.PGUSER) ?? 'postgres',
      ...(password ? { password } : {}),
      sslMode: parseSslMode(e.PGSSLMODE, 'disable'),
      schema,
    };
  }

  throw new DaemonDbConfigError(
    'no database configured. Set DATABASE_URL (local Postgres), PGHOST/PGUSER/PGDATABASE ' +
      '(+ PGPASSWORD), or LAKEBASE_ENDPOINT + PGHOST/PGUSER for Databricks Lakebase.',
  );
}

/** `COMMENT ON SCHEMA` prefix naming the data root a derived schema belongs to. */
export const DATA_DIR_SCHEMA_COMMENT_PREFIX = 'od-data-dir:';

/** Schema name derived from a daemon data root (OD_PG_SCHEMA_PER_DATA_DIR=1). */
export function schemaForDataDir(dataDir: string): string {
  return `od_${createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 24)}`;
}

export function resolveDaemonDbConfigForDataDir(
  dataDir: string,
  env?: Record<string, string | undefined>,
): DaemonDbConfig {
  const e = env ?? process.env;
  const config = resolveDaemonDbConfig(e);
  if (!config.schema && e.OD_PG_SCHEMA_PER_DATA_DIR === '1') {
    return { ...config, schema: schemaForDataDir(dataDir) };
  }
  return config;
}

/** Connection description safe for logs (no secrets). */
export function describeDaemonDbConfig(config: DaemonDbConfig): string {
  if (config.kind === 'url') {
    try {
      const parsed = new URL(config.connectionString ?? '');
      return `postgres ${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
    } catch {
      return 'postgres (DATABASE_URL)';
    }
  }
  const base = `${config.host}:${config.port}/${config.database} as ${config.user}`;
  return config.kind === 'lakebase' ? `lakebase ${base}` : `postgres ${base}`;
}
