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
- The Apps proxy authenticates users before requests reach the container. For
  Wave 1, `app.yaml` sets `OD_DISABLE_API_AUTH=1` (the daemon's existing
  trusted-reverse-proxy mode), because a non-loopback bind otherwise requires
  `OD_API_TOKEN`.
- Browser API calls: the daemon's origin check currently accepts only
  loopback/LAN hosts, so requests from the app's `https://<app-name>.<...>.databricksapps.com`
  origin will be rejected until that host is allowlisted. As an interim measure
  add it via `OD_ALLOWED_ORIGINS` (comma-separated) in `app.yaml` `env`, e.g.
  `OD_ALLOWED_ORIGINS=https://<app-name>.<region>.databricksapps.com`. The auth
  wave will fold Databricks app origins into the check natively.

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

- **Auth**: OBO via `X-Forwarded-Access-Token` replacing `OD_API_TOKEN`,
  Vela/AMR, and external OAuth. Browser origin checks will also need to accept
  the app's `*.databricksapps.com` host (today that needs
  `OD_ALLOWED_ORIGINS`).
- **AI**: Model Serving / AI Gateway replacing the spawned agent CLIs and BYOK.
- **Storage**: UC Volumes for project artifacts.
- **Cleanup**: telemetry (PostHog/Langfuse), media providers, Figma,
  Composio, `tools/pack` and the desktop launcher in `tools/dev`, and the
  upstream desktop/Docker release workflows under `.github/`.
