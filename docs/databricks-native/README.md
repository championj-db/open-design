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
- Auth is on-behalf-of (OBO): `app.yaml` sets `OD_AUTH_MODE=databricks`. See
  [Authentication](#authentication-obo) below.

## Authentication (OBO)

The Apps proxy signs every user in before a request reaches the container and
forwards a short-lived, downscoped user token in `X-Forwarded-Access-Token`.
With `OD_AUTH_MODE=databricks` the daemon builds on that:

- **Every proxied `/api` request must carry the token** and the token must
  verify against SCIM `Me` (`/api/2.0/preview/scim/v2/Me`) on the workspace in
  `DATABRICKS_HOST`. Missing or rejected tokens get `401
  DATABRICKS_AUTH_REQUIRED`; an unreachable SCIM gets `503
  DATABRICKS_IDENTITY_UNAVAILABLE`. There is no fallback to the app service
  principal. Verified identities are cached in memory for up to 5 minutes,
  keyed by a SHA-256 digest of the token. The token itself is never logged
  or persisted. Health / readiness / version probes stay open.
- **In-container callers** (agent tools, the local `od` CLI) reach the daemon
  over loopback without passing the proxy, so they carry none of the proxy's
  `X-Forwarded-*` headers. They keep loopback trust but have no user, so any
  user-scoped Databricks call they trigger fails closed.
- **Two identities, never swapped.** `databricksFetch` (`apps/daemon/src/databricks/client.ts`)
  is the one way daemon code calls a Databricks REST API. `{ as: 'user', req }`
  uses the request's OBO token, so Unity Catalog applies that user's
  permissions. `{ as: 'app' }` uses the app service principal
  (`DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET`, OAuth M2M via
  `/oidc/v1/token`), only for app-owned work no user request is driving.
- **Origins.** The proxy rewrites `Host`, so the daemon treats
  `https://<X-Forwarded-Host>` as the app's own origin. No `OD_ALLOWED_ORIGINS`
  entry is needed, and any other browser origin is still rejected.
- **External sign-in is disabled.** OpenDesign Cloud login, xAI OAuth, MCP
  server OAuth, connector OAuth, and agent CLI login entry points answer `403
  EXTERNAL_AUTH_DISABLED`.
- **Web UI.** First-run onboarding is skipped (`GET /api/app-config` reports
  `onboardingCompleted: true`, not persisted). The rail shows the signed-in
  Databricks user from `GET /api/auth/session` instead of the Cloud sign-in
  card, and nothing redirects to the Cloud sign-in.
- **CLI.** `od auth whoami [--json]` prints the same session. To drive a
  deployed app from outside, point `--daemon-url` at its
  `https://<app>.databricksapps.com` URL and set `DATABRICKS_TOKEN` to a
  Databricks OAuth token (for example from `databricks auth token`). `od` adds
  it as a bearer token only on requests to Databricks Apps origins.
- **Configuration.** `OD_AUTH_MODE=databricks` replaces `OD_API_TOKEN` and
  `OD_DISABLE_API_AUTH`; the daemon refuses to start if either is also set, or
  if `DATABRICKS_HOST` is missing. Enable user authorization on the app with at
  least the `iam.current-user:read` user API scope. Add further scopes only as
  later waves need them.

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

**Wave 1 (deploy skeleton):**

- Added: `app.yaml`, platform port / `0.0.0.0` bind handling in the daemon,
  and these docs.
- Removed: the Electron desktop (`apps/desktop`) and packaged runtime
  (`apps/packaged`), and the Docker / compose / AWS / Azure / Vercel deploy
  targets (`deploy/`, `vercel.json`, `.dockerignore`).

**Auth wave (OBO):** see [Authentication](#authentication-obo). The external
sign-in entry points are disabled rather than deleted; their code goes in the
cleanup wave.

Not done yet, planned for later waves:

- **Database**: Lakebase (Postgres) replacing SQLite / `better-sqlite3`.
- **AI**: Model Serving / AI Gateway replacing the spawned agent CLIs and BYOK.
  Runs that outlive their HTTP request (agent turns) will need their own
  answer for the user's token, which is short-lived and request-scoped today.
- **Storage**: UC Volumes for project artifacts.
- **Cleanup**: telemetry (PostHog/Langfuse), media providers, Figma,
  Composio, `tools/pack` and the desktop launcher in `tools/dev`, and the
  upstream desktop/Docker release workflows under `.github/`.
