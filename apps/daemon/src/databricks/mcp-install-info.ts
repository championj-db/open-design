import type { McpInstallPayload } from '../mcp-install-info.js';

// On a Databricks App the daemon's own runtime lives in the app container, so
// the regular install payload (absolute paths to its Node and CLI, a loopback
// daemon URL) means nothing to a coding agent on the user's machine. Instead
// the agent runs `od mcp` from the user's own checkout against the app's
// public URL. `DATABRICKS_HOST` lets that `od` mint the user's token from
// `databricks auth login` (see `cli-bearer.ts`), so the pasted config keeps
// working past any one token's expiry.

/** Where the snippet expects the CLI entry; the user swaps in their checkout. */
export const DATABRICKS_MCP_CLI_PATH_PLACEHOLDER = '/path/to/open-design/apps/daemon/dist/cli.js';

/** The user's OS from their browser, for config paths and shortcuts. */
export function platformFromUserAgent(userAgent: string | null | undefined): NodeJS.Platform {
  const ua = userAgent ?? '';
  if (/windows/i.test(ua)) return 'win32';
  if (/mac os|macintosh/i.test(ua)) return 'darwin';
  return 'linux';
}

export function databricksMcpInstallPayload(inputs: {
  appUrl: string;
  workspaceHost: string | null;
  userAgent: string | null | undefined;
}): McpInstallPayload {
  return {
    command: 'node',
    args: [DATABRICKS_MCP_CLI_PATH_PLACEHOLDER, 'mcp', '--daemon-url', inputs.appUrl],
    env: inputs.workspaceHost ? { DATABRICKS_HOST: inputs.workspaceHost } : {},
    daemonUrl: inputs.appUrl,
    webBaseUrl: inputs.appUrl,
    platform: platformFromUserAgent(inputs.userAgent),
    // Nothing to probe: the CLI and Node live on the user's machine.
    cliExists: true,
    nodeExists: true,
    buildHint: null,
    databricksApp: {
      appUrl: inputs.appUrl,
      workspaceHost: inputs.workspaceHost,
      cliPathPlaceholder: DATABRICKS_MCP_CLI_PATH_PLACEHOLDER,
    },
  };
}
