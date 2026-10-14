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
  The proxy's upstream `Host` is `localhost:<port>`, so the daemon's
  isolated "powered" preview origin (a second loopback origin) is disabled in
  this mode, and `/api/preview/isolation` reports `supported: false`. Without
  that, every browser API call would be refused as a powered-preview request.
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

## AI (Model Serving)

Generation runs on the workspace's own models, as the signed-in user:

- **Agent.** In Databricks auth mode the daemon registers a `databricks` agent
  (`apps/daemon/src/runtimes/defs/databricks.ts`). It is the default for users
  who have not picked an agent (`GET /api/app-config` reports
  `agentId: "databricks"`; not persisted).
- **Harness.** A run spawns OpenDesign's own chat/tool loop
  (`apps/daemon/src/databricks/agent-harness.ts`) with the daemon's Node; no
  external agent CLI is installed. It calls the OpenAI-compatible
  `POST /serving-endpoints/chat/completions` with streaming and tool calling.
  It speaks Claude Code stream-json, so the existing parser and the web's
  execution record work unchanged.
- **Identity.** The run uses the on-behalf-of token of the user whose request
  started it (`DATABRICKS_HOST` / `DATABRICKS_TOKEN` in that child's env only;
  never written to run metadata). Endpoint permissions, AI Gateway policies
  and usage attribution therefore apply to that user. A run without a user
  token fails with `DATABRICKS_AUTH_REQUIRED`; it never falls back to the app
  service principal, whose credentials are stripped from every agent child's
  env in this mode.
- **Models.** `/api/agents` lists the ready `llm/v1/chat` endpoints the caller
  can see as the agent's models. "Default" resolves to
  `OD_DATABRICKS_DEFAULT_MODEL`, else `databricks-claude-sonnet-4-5`.
- **Tools.** Write, Edit, Read, Glob, Grep and TodoWrite, confined to the run's
  project directory. There is deliberately no shell, because all signed-in
  users share one app container.
- **Scopes.** The app needs the `model-serving` user API scope (plus
  `iam.current-user:read` for identity). Users need CAN QUERY on the endpoints
  they pick.
- **Limits.** The user token is short-lived, so a run that outlives it fails
  with a "send the message again" error. The OpenDesign CLI (`od media …`,
  `od export …` and similar) is unavailable to this agent, with or without a
  sandbox, so its prompt carries the direction library inline and steps that
  need the CLI are skipped. For a general shell, see
  [Sandbox shell](#sandbox-shell).

## Sandbox shell

With `OD_DATABRICKS_SANDBOX=1` (set in `app.yaml`), the Databricks agent gets a
`Bash` tool that runs in a
[Databricks Sandbox](https://docs.databricks.com/aws/en/compute/serverless/sandbox)
(Beta), never in the shared app container.

- **Owned by the app.** Databricks Apps has no `sandbox` user API scope, so the
  daemon creates and drives sandboxes as the app's service principal
  (`apps/daemon/src/databricks/sandbox-broker.ts`). The agent reaches its
  sandbox only through the daemon (`POST /api/tools/databricks/sandbox/exec`)
  with its run-scoped tool token; it never receives the service principal's
  credentials, and sandboxes are created without Databricks credentials
  inside.
- **Ephemeral, one per conversation.** Each user conversation gets its own
  sandbox under a random `od-session-…` name, created on its first command and
  reused for the rest of that conversation. The daemon deletes it after 15
  idle minutes and on shutdown; at startup it deletes any `od-session-…`
  sandbox a previous daemon left behind. Installed packages do not outlive the
  sandbox.
- **Files.** Before each command the project is copied into
  `/home/sandbox-agent/opendesign/projects/<project id>` (changed files only);
  afterwards, files the command created, changed or deleted are applied back
  to the project. `node_modules`, `.git` and similar trees are not copied, nor
  files over 25 MB. The project in the daemon data root stays the only durable
  copy, and it persists through the [UC volume mirror](#persistence-uc-volume).
- **Requirements.** The workspace needs the Databricks Sandbox preview, and the
  app's service principal must be able to create sandboxes. The daemon checks
  at startup; if it cannot, the agent keeps the file tools only and the run
  still works.
- **Limits.** Sandbox egress is unrestricted. The OpenDesign CLI is not
  installed there. Each command adds a few seconds of sync round trips, and a
  single command times out after at most 280 seconds. Sandbox compute is
  billed to the app's service principal, not to each user.

## Persistence (UC Volume)

The container disk is wiped on every deploy and restart. The daemon therefore
mirrors its data root (the SQLite database, project files, and the rest of the
daemon data described by the data directory contract in the root `AGENTS.md`)
to a Unity Catalog volume:

- **Setup.** Create a volume, add it to the app as a resource with **Can read
  and write**, and point `OD_DATA_VOLUME` at its resource key in `app.yaml`
  (`valueFrom: <key>`). Databricks grants the app's service principal access;
  users need no grants on the volume.
- **Startup.** Before anything reads the data root, the daemon restores it from
  the volume. If the volume cannot be read, the daemon does not start: starting
  empty would let the first sync overwrite the saved data.
- **While running.** Every 30 seconds, files that changed are uploaded and a new
  manifest is published after them; files deleted locally are then removed.
  SQLite databases are uploaded as consistent snapshots, not raw files. Logs,
  diagnostics, telemetry, caches and agent runtime homes are not mirrored.
- **Shutdown.** A final sync runs after active runs stop.
- **Limits.** A crash can lose up to 30 seconds of changes. The mirror assumes
  one app instance; two instances would overwrite each other's manifest.

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

**AI wave:** see [AI (Model Serving)](#ai-model-serving).

**Persistence:** see [Persistence (UC Volume)](#persistence-uc-volume).

**Sandbox:** see [Sandbox shell](#sandbox-shell).

Not done yet, planned for later waves:

- **Database**: Lakebase (Postgres) replacing SQLite / `better-sqlite3`.
- **AI follow-ups**: remove the BYOK / external agent CLI paths, and refresh
  the user token for runs longer than its lifetime.
- **Cleanup**: telemetry (PostHog/Langfuse), media providers, Figma,
  Composio, `tools/pack` and the desktop launcher in `tools/dev`, and the
  upstream desktop/Docker release workflows under `.github/`.
