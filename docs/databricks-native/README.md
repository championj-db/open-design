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

## Building the bundle

The daemon runs from built output, so build before deploying:

```bash
corepack pnpm install
corepack pnpm --filter @open-design/daemon build   # -> apps/daemon/dist/cli.js
corepack pnpm --filter @open-design/web build      # -> apps/web/out
```

Then sync the repo root to the workspace and deploy it with
`databricks apps deploy`.

## Status: Wave 1 (skeleton only)

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
- **Database**: Lakebase (Postgres) replacing SQLite / `better-sqlite3`.
- **AI**: Model Serving / AI Gateway replacing the spawned agent CLIs and BYOK.
- **Storage**: UC Volumes for project artifacts.
- **Cleanup**: telemetry (PostHog/Langfuse), media providers, Figma,
  Composio, `tools/pack` and the desktop launcher in `tools/dev`, and the
  upstream desktop/Docker release workflows under `.github/`.
