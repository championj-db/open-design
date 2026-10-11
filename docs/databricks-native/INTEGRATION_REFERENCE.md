# Databricks-Native OpenDesign — Integration Reference

> Authoritative-enough starting contracts gathered from Databricks docs (Oct 2026).
> Treat exact endpoint paths/model ids as **verify-against-the-live-workspace**, not gospel —
> use the workspace host provided to the app at runtime (`https://<your-workspace-host>`;
> the initial deployment targets `dbc-a5d4177a-49dc.cloud.databricks.com`). Where a detail is
> uncertain, probe the running Apps environment / `databricks` CLI before hardcoding.
>
> NOTE: this reference describes the migration's **target** architecture (all waves). Any
> "removed/replaced" statement is the end-state; see `README.md` for what has actually shipped per wave.

This app is **Node.js 24 / TypeScript (pnpm monorepo)**, Express daemon serving a static
Next.js export. All patterns below must be implemented in TS, not Python.

---

## 1. Databricks Apps runtime contract
- `app.yaml` (or `app.yml`) at the deploy root. `command` is an **array** (no shell), e.g.
  `command: ["node", "apps/daemon/dist/cli.js", "--no-open"]`. pnpm apps **require an explicit command**.
- Port: Databricks injects **`DATABRICKS_APP_PORT`** and the app **must listen on that port and host `0.0.0.0`**.
  For Express/Node, Databricks also auto-sets **`PORT`**. So resolve:
  `const port = process.env.PORT ?? process.env.DATABRICKS_APP_PORT`.
  The literal token `DATABRICKS_APP_PORT` inside `command` args is substituted with the real port at runtime.
- `env:` list supports `value:` (plain) and `valueFrom:` (secret / sql_warehouse / UC resource / etc.) — use
  `valueFrom` for anything sensitive; never bake secrets into `value`.
- No persistent local disk guarantees, no spawning arbitrary external binaries, no loopback OAuth callback servers.
- System env vars available in-app include the workspace host and the app's service-principal identity.

## 2. Authentication / On-Behalf-Of (OBO) — replaces OD_API_TOKEN + all external OAuth
- Enable **user authorization (OBO)** on the app; select the **minimum** user API scopes needed.
- Per request, read header **`X-Forwarded-Access-Token`** = short-lived OAuth token for the signed-in user.
  - **Fail closed** if absent (do NOT silently fall back to the app service principal for user actions).
  - Never log or persist it; read it fresh each request.
- `X-Forwarded-Email` / `X-Forwarded-User` / `X-Forwarded-Preferred-Username` = identity **hints** for UI
  display only — NOT authorization. For a trustworthy identity, call SCIM "Me":
  `GET https://<host>/api/2.0/preview/scim/v2/Me` with `Authorization: Bearer <X-Forwarded-Access-Token>`
  → stable user id, userName (email), groups.
- Two client identities to keep separate:
  - **User-scoped** (OBO token) → user-facing data/AI calls so Unity Catalog enforces that user's permissions.
  - **App service principal** (workspace M2M) → only for app-owned infra tasks where OBO isn't applicable.

## 3. Lakebase (managed Postgres) — replaces SQLite / better-sqlite3
- Standard Postgres wire protocol. Use **`pg` (node-postgres)**.
- Connection: host from the Lakebase "Connect" dialog (`ep-...`), **port 5432**, database typically
  **`databricks_postgres`**, **`sslmode=require`** (TLS mandatory).
- **Username** = the Lakebase Postgres role bound to a Databricks identity (user email, or SP client-id GUID).
- **Password** = a **short-lived (~60 min) OAuth database credential** — must be refreshed/rotated.
  - `node-postgres` supports an **async `password` function** that returns a fresh token per connection — use that.
  - Mint via CLI `databricks postgres generate-database-credential ...`, or REST:
    `POST {host}/oidc/v1/token` (client_credentials) then `POST {host}/api/2.0/postgres/credentials`.
- Migration implication: the existing hand-written `CREATE TABLE` + in-code migrations against `better-sqlite3`
  must be rewritten to Postgres SQL with a real migration runner. Watch for SQLite-isms:
  `AUTOINCREMENT`→`GENERATED ... AS IDENTITY`/`BIGSERIAL`, dynamic typing, `INSERT OR REPLACE`→`ON CONFLICT`,
  `datetime('now')`→`now()`, boolean-as-int, `json` as TEXT vs native `jsonb`, `PRAGMA`, `.changes`/`lastInsertRowid`.

## 4. AI — Mosaic AI Gateway / Model Serving ("unity gateway") — replaces node-pty CLIs + BYOK + Vela/AMR
- Call Databricks serving endpoints with the **Databricks token** (OBO user token preferred, else SP). No vendor API keys.
- Two usable surfaces (verify which the workspace exposes):
  - **Unified Chat Completions (provider-agnostic, preferred default):**
    `POST https://<host>/serving-endpoints/<endpoint>/invocations` — OpenAI-chat-shaped. Works with the
    `openai` SDK pointed at `baseURL = https://<host>/serving-endpoints` + bearer token. Supports streaming + tool-calling.
  - **Anthropic Messages passthrough:** `POST https://<host>/ai-gateway/anthropic/v1/messages` with
    `Authorization: Bearer <token>`; model id like `databricks-claude-sonnet-4-5`. Good for migrating the
    existing `@anthropic-ai/sdk` streaming/tool-use path with minimal reshaping.
- Discover available endpoints dynamically: `GET https://<host>/api/2.0/serving-endpoints` (list), rather than
  hardcoding one model. Pick a Claude-family endpoint as the default "Claude Code replacement" brain.
- The former agent-CLI orchestration (spawn `claude`/`codex`/etc via node-pty) is **replaced in the AI wave**:
  the daemon itself becomes the agent harness, running the chat/tool loop in-process and calling serving
  endpoints for model turns. (Still present until that wave lands — see `README.md` for current status.)

## 5. Artifact storage (Wave 3) — Unity Catalog Volumes replaces local `.od/projects/`
- Relational state → Lakebase; **files/artifacts → UC Volumes** via the existing `S3ProjectStorage` seam
  (`apps/daemon/src/storage/project-storage.ts`, `OD_PROJECT_STORAGE=s3`). UC Volumes are reachable via the
  Files API / `/Volumes/<catalog>/<schema>/<volume>/...` paths with the Databricks token.

## 6. What gets removed (no external logins/services outside Databricks)
Vela/AMR cloud (login, wallet, billing), xAI OAuth, MCP OAuth loopback servers, Composio + GitHub connectors,
PostHog + Langfuse telemetry, Vercel/Cloudflare/EdgeOne deploy targets, Figma, Tavily, all external media-gen
providers (ElevenLabs/BFL/Kling/Leonardo/Replicate/Topaz/etc), the Electron desktop + packaged builds, and the
non-Databricks Docker/AWS/Azure deploy templates.
