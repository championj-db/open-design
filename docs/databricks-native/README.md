# Databricks-native OpenDesign

OpenDesign is being migrated to run as a [Databricks App](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/).
The integration contracts for the whole migration (runtime, OBO auth, Lakebase,
Model Serving, UC Volumes, removal list) live in
[`INTEGRATION_REFERENCE.md`](./INTEGRATION_REFERENCE.md).

## Deployment model

- One process. The daemon (`apps/daemon`) serves `/api/*` and the static
  Next.js export of `apps/web` (`apps/web/out`). There is no separate web
  server and no Docker image.
- `app.yaml` at the repo root is the Apps spec. Its `command` (array form, no
  shell) is `node apps/daemon/dist/cli.js --no-open`.
- Databricks injects `DATABRICKS_APP_PORT` (and `PORT` for Node apps). The
  daemon resolves its port as `PORT` → `DATABRICKS_APP_PORT` → `OD_PORT` →
  `7456`, and binds `0.0.0.0` whenever a platform port is present. An explicit
  `OD_BIND_HOST` still wins. Local runs with none of these set keep the
  loopback default `127.0.0.1:7456`.
- Auth is per-request on-behalf-of (OBO); see "Authentication" below.

## Authentication (OBO)

The Apps proxy signs users in and forwards a short-lived user OAuth token in
`X-Forwarded-Access-Token`. The daemon's `/api/*` gate
(`apps/daemon/src/auth/databricks-obo.ts`) requires it on every request:

- The token is exchanged for an identity with SCIM
  `GET {DATABRICKS_HOST}/api/2.0/preview/scim/v2/Me`. The resolved user (stable
  id, userName/email, display name, group names) is cached per token for 60
  seconds, keyed by a hash of the token. The token itself is never logged or
  stored.
- No token, or a token SCIM rejects, is a `401`. SCIM unreachable is a `503`.
  There is no fallback to the app service principal.
- `X-Forwarded-Email` / `-User` / `-Preferred-Username` are display hints and
  are never used for authorization.
- Admitted without a user: `/api/health`, `/api/ready`, `/api/version`; GETs of
  server-minted project preview asset scopes (sandboxed iframes cannot send
  headers); and run-scoped agent tool tokens on the exact tool routes their
  grant names (each route still checks operation and project).
- Route code reads the caller with `getCurrentUser(req)` /
  `requireCurrentUser()` from `apps/daemon/src/auth/current-user.ts`
  (request-scoped, also available through AsyncLocalStorage). Data is not yet
  scoped per user; the store is still single-tenant.

Enable **user authorization** on the app (the default user identity scope is
enough for SCIM `Me`). `DATABRICKS_HOST` is injected by the platform.

Local development outside Databricks Apps: set `OD_LOCAL_DEV_USER=<email>` to
run requests without a forwarded token as that user. It is off by default, and
the daemon refuses to start with it when `DATABRICKS_APP_NAME` or
`DATABRICKS_APP_PORT` is set. With `DATABRICKS_HOST` pointed at a workspace,
you can also send a real `X-Forwarded-Access-Token` locally.

Browser origin check: besides loopback/LAN, the daemon accepts the app's own
origin (`DATABRICKS_APP_URL`, and any `https://*.databricksapps.com` origin that
matches the request's `Host` / `X-Forwarded-Host`, i.e. same-origin through the
proxy). Other `databricksapps.com` apps are not trusted automatically; list any
extra origin in `OD_ALLOWED_ORIGINS` (comma-separated).

`OD_API_TOKEN` and `OD_DISABLE_API_AUTH` were removed.

## Database: Lakebase (Postgres)

The daemon's relational state (projects, conversations, messages, plugins,
routines, …) lives in PostgreSQL. In a Databricks App that is a Lakebase
database; locally any Postgres works. Non-database project files stay on the
filesystem under the daemon data root.

The backend is selected from env at startup (`apps/daemon/src/storage/daemon-db.ts`):

| Mode | Selected when | Variables |
| --- | --- | --- |
| Connection string | `DATABASE_URL` is set | `DATABASE_URL`, optional `PGSSLMODE` |
| Lakebase | `LAKEBASE_ENDPOINT` is set | `LAKEBASE_ENDPOINT` (`projects/<p>/branches/<b>/endpoints/<e>`), `PGHOST` or `LAKEBASE_HOST`, `PGPORT` (5432), `PGDATABASE` (`databricks_postgres`), `PGUSER` / `LAKEBASE_USER` / `DATABRICKS_CLIENT_ID`, `PGSSLMODE` (`require`) |
| Plain Postgres | `PGHOST` is set | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE` (`disable`) |

Common: `OD_PG_SCHEMA` pins the schema the daemon owns (default `public`);
`OD_PG_LOCK_TIMEOUT_MS` (default 5000) bounds lock waits.

In Lakebase mode the Postgres password is a short-lived (~60 min) OAuth
database credential. node-postgres asks for it through an async `password`
callback on every new connection, which mints one via
`apps/daemon/src/storage/postgres/lakebase-credentials.ts`:

- `OD_LAKEBASE_CREDENTIAL_SOURCE=rest` (default when `DATABRICKS_HOST` is set):
  `POST {DATABRICKS_HOST}/api/2.0/postgres/credentials`, authenticated with
  `DATABRICKS_TOKEN` or the app service principal (`DATABRICKS_CLIENT_ID` /
  `DATABRICKS_CLIENT_SECRET`, OIDC client-credentials).
- `OD_LAKEBASE_CREDENTIAL_SOURCE=cli`: `databricks postgres
  generate-database-credential <endpoint>` (`OD_DATABRICKS_CLI`,
  `DATABRICKS_CONFIG_PROFILE`).

Credentials are cached until five minutes before expiry and idle connections
are recycled every 45 minutes.

Schema: an ordered migration list (`DAEMON_MIGRATIONS` in
`apps/daemon/src/db.ts`, runner in `storage/postgres/migrations.ts`) is applied
at startup in one transaction under an advisory lock and recorded in
`od_schema_migrations`.

Local development: point `DATABASE_URL` at a local Postgres 16+, e.g.
`DATABASE_URL=postgres://postgres@127.0.0.1:5432/opendesign`. The daemon test
suite provisions a throwaway cluster itself when `DATABASE_URL` is unset and
`initdb` is available (`apps/daemon/tests/global-setup-postgres.ts`).

Not migrated: existing `app.sqlite` contents are not imported into Postgres.

Known limitation (until the async data layer lands): the daemon still calls
the database synchronously through a worker thread. If that worker stops
answering while a write or COMMIT is on the server, the outcome is unknown;
the daemon reports it as `OD_BRIDGE_INDETERMINATE` (and logs it) instead of
guessing. The async follow-up resolves this with idempotent operations.

## Building the bundle

The daemon runs from built output, so build before deploying:

```bash
corepack pnpm install
corepack pnpm --filter @open-design/daemon build   # -> apps/daemon/dist/cli.js
corepack pnpm --filter @open-design/web build      # -> apps/web/out
```

Then sync the repo root to the workspace and deploy it with
`databricks apps deploy`.

## Status

Wave 2 (auth): OBO request authentication replaced `OD_API_TOKEN` (see
"Authentication" above).

Wave 2 (database): the daemon's relational store moved from SQLite /
`better-sqlite3` to Postgres / Lakebase (see "Database" above). Per-user data
isolation is not part of it yet; the store is still single-tenant.

### Wave 1 (skeleton only)

This wave only adds the deploy skeleton and removes platforms we are dropping:

- Added: `app.yaml`, platform port / `0.0.0.0` bind handling in the daemon,
  and these docs.
- Removed: the Electron desktop (`apps/desktop`) and packaged runtime
  (`apps/packaged`), and the Docker / compose / AWS / Azure / Vercel deploy
  targets (`deploy/`, `vercel.json`, `.dockerignore`).

Not done yet, planned for later waves:

- **AI**: Model Serving / AI Gateway replacing the spawned agent CLIs and BYOK.
- **Storage**: UC Volumes for project artifacts.
- **Cleanup**: telemetry (PostHog/Langfuse), media providers, Figma,
  Composio, `tools/pack` and the desktop launcher in `tools/dev`, and the
  upstream desktop/Docker release workflows under `.github/`.
