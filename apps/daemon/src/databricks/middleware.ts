import type { Request, RequestHandler } from 'express';

import { sendApiError } from '../http/api-errors.js';
import { isLoopbackPeerAddress } from '../http/local-daemon-request.js';
import { cameThroughDatabricksAppsProxy, forwardedAccessToken } from './forwarded-headers.js';
import { DatabricksIdentityError, type DatabricksIdentityResolver } from './identity.js';
import { bindDatabricksRequestContext } from './request-context.js';

export interface DatabricksAuthMiddlewareOptions {
  identity: DatabricksIdentityResolver;
  /** Requests that stay open without a user: health / readiness / version probes, scoped preview assets. */
  isOpenRequest: (req: Request) => boolean;
}

/**
 * `/api` authentication in Databricks auth mode. Every request that came
 * through the Apps proxy must carry `X-Forwarded-Access-Token`, and that token
 * must verify against SCIM `Me`; otherwise the request is refused (fail
 * closed). The verified user and token are bound to the request for
 * `databricksRequestContext` / `databricksFetch`.
 *
 * In-container callers (agent tools, the local `od` CLI) reach the daemon over
 * loopback without passing the proxy. They keep the trust local auth mode
 * gives loopback, but carry no user, so any user-scoped Databricks call they
 * trigger fails closed.
 */
export function createDatabricksAuthMiddleware({
  identity,
  isOpenRequest,
}: DatabricksAuthMiddlewareOptions): RequestHandler {
  return async (req, res, next) => {
    if (isOpenRequest(req)) return next();
    const accessToken = forwardedAccessToken(req);
    if (!accessToken) {
      if (!cameThroughDatabricksAppsProxy(req) && isLoopbackPeerAddress(req.socket?.remoteAddress)) {
        return next();
      }
      return sendApiError(
        res,
        401,
        'DATABRICKS_AUTH_REQUIRED',
        'This request carried no Databricks user token. Reload the app to sign in again.',
      );
    }
    let user;
    try {
      user = await identity.resolve(accessToken);
    } catch (error) {
      if (error instanceof DatabricksIdentityError && error.failure === 'rejected') {
        return sendApiError(res, 401, 'DATABRICKS_AUTH_REQUIRED', `${error.message}. Reload the app to sign in again.`);
      }
      if (error instanceof DatabricksIdentityError && error.failure === 'forbidden') {
        return sendApiError(res, 403, 'DATABRICKS_AUTH_REQUIRED', error.message);
      }
      console.warn('[databricks-auth] could not verify the forwarded user token', {
        error: error instanceof Error ? error.message : String(error),
      });
      return sendApiError(
        res,
        503,
        'DATABRICKS_IDENTITY_UNAVAILABLE',
        'Could not verify your Databricks identity. Try again shortly.',
        { retryable: true },
      );
    }
    bindDatabricksRequestContext(req, { user, accessToken });
    return next();
  };
}

// Entry points of every external sign-in / OAuth flow. On a Databricks App the
// platform is the only identity provider, so these are refused outright
// instead of starting a flow (or accepting a callback) for a third party.
// Status and disconnect routes stay reachable: they only report or clear
// local state. Patterns are case-insensitive and tolerate a trailing slash
// because Express routing matches those variants too.
const EXTERNAL_AUTH_ENTRY_POINTS: ReadonlyArray<{ method: string; path: RegExp; flow: string }> = [
  { method: 'POST', path: /^\/api\/integrations\/vela\/login\/?$/i, flow: 'OpenDesign Cloud sign-in' },
  { method: 'POST', path: /^\/api\/xai\/oauth\/(start|complete)\/?$/i, flow: 'xAI OAuth' },
  { method: 'POST', path: /^\/api\/mcp\/oauth\/start\/?$/i, flow: 'MCP server OAuth' },
  { method: 'GET', path: /^\/api\/mcp\/oauth\/callback\/?$/i, flow: 'MCP server OAuth' },
  { method: 'POST', path: /^\/api\/connectors\/[^/]+\/connect\/?$/i, flow: 'connector OAuth' },
  { method: 'GET', path: /^\/api\/connectors\/oauth\/callback\/[^/]+\/?$/i, flow: 'connector OAuth' },
  { method: 'POST', path: /^\/api\/agents\/[^/]+\/oauth-launch\/?$/i, flow: 'agent CLI sign-in' },
];

export function externalAuthFlowForRequest(method: string, path: string): string | null {
  const upper = method.toUpperCase();
  return EXTERNAL_AUTH_ENTRY_POINTS.find((entry) => entry.method === upper && entry.path.test(path))?.flow ?? null;
}

export function createExternalAuthDisabledMiddleware(): RequestHandler {
  return (req, res, next) => {
    const flow = externalAuthFlowForRequest(req.method, req.path);
    if (!flow) return next();
    return sendApiError(
      res,
      403,
      'EXTERNAL_AUTH_DISABLED',
      `${flow} is disabled on this deployment: users are signed in through Databricks.`,
    );
  };
}
