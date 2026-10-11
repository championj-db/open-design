import type { Express } from 'express';
import fs from 'node:fs';
import { SIDECAR_ENV } from '@open-design/sidecar-proto';
import { buildMcpInstallPayload, type McpInstallPayload } from './mcp-install-info.js';
import { installCodexMcp, probeCodexInstall, refreshOwnedCodexMcp, uninstallCodexMcp } from './codex-cli.js';
import { isManagedMcpBootstrapEnv } from './mcp-bootstrap.js';
import { isCodexRegistrationOwnedBy, managedMcpRegistrationEnv } from './mcp-managed-registration.js';
import { MCP_TEMPLATES, buildAcpMcpServers, buildClaudeMcpJson, isManagedProjectCwd, readMcpConfig, writeMcpConfig } from './mcp-config.js';
import type { RouteDeps } from './server-context.js';

export interface RegisterMcpRoutesDeps extends RouteDeps<'http' | 'paths' | 'mcp'> {}

// Lets the daemon finish binding its port before the registration is rebuilt.
const MCP_REGISTRATION_REFRESH_DELAY_MS = 5_000;

export function registerMcpRoutes(app: Express, ctx: RegisterMcpRoutesDeps) {
  const { isLocalSameOrigin, resolvedPortRef, sendApiError } = ctx.http;
  const { OD_BIN, RUNTIME_DATA_DIR, PROJECTS_DIR } = ctx.paths;
  const { daemonUrlRef, inheritedEnvironment } = ctx.mcp;
  const getResolvedPort = () => resolvedPortRef.current;
  const getDaemonUrl = () => daemonUrlRef.current;
  // Surfaces the absolute paths to the daemon's Node-compatible runtime and
  // CLI entry so the Settings → MCP server panel can render snippets that work
  // even when `od` isn't on the user's PATH (the common case for source clones
  // - and macOS/Linux ship a /usr/bin/od octal-dump tool that shadows ours
  // anyway). Cached for 5s because the panel pings on every open. The
  // executable paths remain stable for the daemon lifetime, while the
  // packaged web port is part of the cache key because it is registered
  // after the web sidecar binds and may change after a runtime restart.
  const INSTALL_INFO_TTL_MS = 5000;
  let installInfoCache: {
    t: number;
    payload: object;
    webPort: string | null;
  } | null = null;

  // Resolve the install snippet for the current daemon. Shared by the
  // public GET /api/mcp/install-info endpoint (renders TOML/JSON for
  // the user to copy) and POST /api/mcp/install/codex (which feeds the
  // exact same fields into `codex mcp add` so the one-click install
  // configures Codex with byte-for-byte the same command as the copy
  // snippet would). Keeping this in one place is the whole point of
  // the factoring — divergence here would mean Codex behaves
  // differently depending on which install path the user took.
  function computeInstallPayload(): McpInstallPayload {
    const cliPath = OD_BIN;
    // Forward only the opaque inherited client capability. IPC endpoint
    // naming and transport stay private to @open-design/sidecar.
    const sidecarEnv = inheritedEnvironment();
    const isSidecarMode = Object.keys(sidecarEnv).length > 0;
    const mcpBootstrapCommand = process.env.OD_MCP_BOOTSTRAP_COMMAND;
    if (
      mcpBootstrapCommand != null
      && mcpBootstrapCommand.length > 0
    ) {
      sidecarEnv.OD_MCP_BOOTSTRAP_COMMAND = mcpBootstrapCommand;
    }
    const mcpBootstrapArgs = process.env.OD_MCP_BOOTSTRAP_ARGS;
    if (mcpBootstrapArgs != null && mcpBootstrapArgs.length > 0) {
      sidecarEnv.OD_MCP_BOOTSTRAP_ARGS = mcpBootstrapArgs;
    }
    Object.assign(sidecarEnv, managedMcpRegistrationEnv());
    // tools-dev / packaged launchers export OD_WEB_PORT so the daemon
    // knows where the browser-facing OpenDesign studio is running.
    // CLI-only / headless launches set neither and webBaseUrl falls
    // through as null — MCP clients then just omit the studio deep
    // link from their responses.
    const webPortRaw = process.env[SIDECAR_ENV.WEB_PORT];
    const webPortNum = webPortRaw ? Number(webPortRaw) : Number.NaN;
    const webBaseUrl = Number.isFinite(webPortNum) && webPortNum > 0
      ? `http://127.0.0.1:${webPortNum}`
      : null;
    return buildMcpInstallPayload({
      cliPath,
      cliExists: fs.existsSync(cliPath),
      // process.execPath is the absolute path to the Node-compatible
      // runtime running the daemon RIGHT NOW. In packaged builds this
      // may be Electron with ELECTRON_RUN_AS_NODE=1 rather than a
      // separate bundled Node binary; the helper surfaces that env
      // requirement on the command so IDE-spawned MCP clients can
      // reproduce the same mode from a minimal OS launcher env.
      execPath: process.execPath,
      nodeExists: fs.existsSync(process.execPath),
      port: getResolvedPort(),
      platform: process.platform,
      dataDir: RUNTIME_DATA_DIR,
      electronAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
      isSidecarMode,
      sidecarEnv,
      webBaseUrl,
    });
  }

  app.get('/api/mcp/install-info', (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const now = Date.now();
    const webPort = process.env[SIDECAR_ENV.WEB_PORT] ?? null;
    if (
      installInfoCache
      && installInfoCache.webPort === webPort
      && now - installInfoCache.t < INSTALL_INFO_TTL_MS
    ) {
      return res.json(installInfoCache.payload);
    }
    const payload = computeInstallPayload();
    installInfoCache = { t: now, payload, webPort };
    res.json(payload);
  });

  // Codex one-click install. Codex CLI exposes `codex mcp add/remove/get`,
  // so we shell out to it rather than rewriting ~/.codex/config.toml
  // ourselves — that way we inherit Codex's merge / validation rules
  // and only need to track its argv. See apps/daemon/src/codex-cli.ts.
  const CODEX_MCP_NAME = 'open-design';

  // Under a managed outer, keep this install's own Codex registration pointed
  // at the runtime that is running now. Registrations name a versioned
  // payload, and a payload version is only cleaned up after a newer one has
  // started here, so refreshing on every start keeps them valid. The
  // registration name is global, so a registration written by another install
  // (another channel, a local build) is left exactly as it is. Never installs one.
  if (isManagedMcpBootstrapEnv(process.env)) {
    const timer = setTimeout(() => {
      const payload = computeInstallPayload();
      if (!payload.cliExists || !payload.nodeExists) return;
      refreshOwnedCodexMcp(
        { name: CODEX_MCP_NAME, command: payload.command, args: payload.args, env: payload.env },
        (existing) => isCodexRegistrationOwnedBy(existing, payload),
      )
        .then((outcome) => console.info('[mcp] codex registration refresh', { outcome }))
        .catch((err: unknown) => console.warn('[mcp] codex registration refresh failed', {
          error: err instanceof Error ? err.message : String(err),
        }));
    }, MCP_REGISTRATION_REFRESH_DELAY_MS);
    timer.unref?.();
  }

  app.get('/api/mcp/install/codex/status', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const status = await probeCodexInstall(CODEX_MCP_NAME);
      res.json(status);
    } catch (err) {
      sendApiError(res, 500, 'CODEX_PROBE_FAILED', err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/mcp/install/codex', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const payload = computeInstallPayload();
    if (!payload.cliExists || !payload.nodeExists) {
      return sendApiError(res, 500, 'INSTALL_INFO_INCOMPLETE', payload.buildHint ?? 'install payload not ready');
    }
    try {
      await installCodexMcp({
        name: CODEX_MCP_NAME,
        command: payload.command,
        args: payload.args,
        env: payload.env,
      });
      res.json({ ok: true });
    } catch (err) {
      sendApiError(res, 500, 'CODEX_INSTALL_FAILED', err instanceof Error ? err.message : String(err));
    }
  });

  app.delete('/api/mcp/install/codex', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      await uninstallCodexMcp(CODEX_MCP_NAME);
      res.json({ ok: true });
    } catch (err) {
      sendApiError(res, 500, 'CODEX_UNINSTALL_FAILED', err instanceof Error ? err.message : String(err));
    }
  });

  // External MCP server configuration. OpenDesign connects to these as a
  // CLIENT and surfaces their tools to the underlying agent at spawn time.
  // GET returns user-saved entries plus the built-in template list so the UI
  // can render the "Add MCP server" picker without a second round-trip.
  app.get('/api/mcp/servers', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const cfg = await readMcpConfig(RUNTIME_DATA_DIR);
      res.json({ servers: cfg.servers, templates: MCP_TEMPLATES });
    } catch (err: any) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/mcp/servers', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const cfg = await writeMcpConfig(RUNTIME_DATA_DIR, req.body);
      res.json({ servers: cfg.servers, templates: MCP_TEMPLATES });
    } catch (err: any) {
      res
        .status(400)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });
}
