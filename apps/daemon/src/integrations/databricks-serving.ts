// Databricks Model Serving ("unity gateway") client.
//
// The in-process Databricks agent (`agent-protocol/databricks/`) calls a
// serving endpoint through the OpenAI-compatible Chat Completions surface:
//
//   POST https://<host>/serving-endpoints/<endpoint>/invocations
//
// with `stream: true` and OpenAI-shaped `tools`, and reads back
// `chat.completion.chunk` SSE frames. Endpoint discovery uses
// `GET https://<host>/api/2.0/serving-endpoints`.
//
// Auth is a Databricks bearer token and nothing else — no vendor API keys.
// The per-request OBO user token is preferred so Unity Catalog governs model
// access per user; the app service principal (OAuth client credentials) or a
// local-dev `DATABRICKS_TOKEN` is the fallback when no user token exists. The
// client fails closed: without a token no request is sent. Tokens are never
// logged and never included in error messages.
//
// The HTTP layer is an injectable `fetch` so tests run against a mock
// endpoint.
import { databricksHostOrigin } from '../auth/databricks-obo.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DATABRICKS_SERVING_ENDPOINT_ENV = 'OD_DATABRICKS_SERVING_ENDPOINT';

/** The configured default serving endpoint, or null when none is configured. */
export function configuredServingEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[DATABRICKS_SERVING_ENDPOINT_ENV]?.trim() || null;
}

/**
 * Chat-capable, READY serving endpoints, Claude-family first. Endpoints whose
 * task is unknown are kept (external-model endpoints often omit it);
 * embeddings and other non-chat tasks, and endpoints that are not READY, are
 * dropped — a not-ready endpoint cannot answer a run.
 */
export function readyChatEndpoints(endpoints: readonly ServingEndpointSummary[]): ServingEndpointSummary[] {
  return endpoints
    .filter((endpoint) => endpoint.ready && (!endpoint.task || endpoint.task.includes('chat')))
    .sort((a, b) => {
      const claudeA = a.name.includes('claude') ? 0 : 1;
      const claudeB = b.name.includes('claude') ? 0 : 1;
      return claudeA - claudeB || a.name.localeCompare(b.name);
    });
}

/**
 * The serving endpoint a run calls: the explicitly selected model, else
 * `OD_DATABRICKS_SERVING_ENDPOINT`, else the first READY chat endpoint the
 * caller can see. There is no hard-coded fallback — a workspace without that
 * endpoint would only fail later with a confusing 404.
 */
export async function resolveServingEndpoint(options: {
  model: string | null;
  env: NodeJS.ProcessEnv;
  client: Pick<DatabricksServingClient, 'listEndpoints'>;
  signal?: AbortSignal;
}): Promise<string> {
  const selected = options.model?.trim();
  if (selected && selected !== 'default') return selected;
  const configured = configuredServingEndpoint(options.env);
  if (configured) return configured;
  let discovered: ServingEndpointSummary[] = [];
  try {
    discovered = readyChatEndpoints(await options.client.listEndpoints(options.signal));
  } catch (err) {
    if (err instanceof DatabricksServingError && err.code !== 'DATABRICKS_SERVING_HTTP') throw err;
    // Listing failed: fall through to the configuration error below.
  }
  const first = discovered[0];
  if (first) return first.name;
  throw new DatabricksServingError(
    'DATABRICKS_SERVING_CONFIG',
    `No Model Serving endpoint is configured: set ${DATABRICKS_SERVING_ENDPOINT_ENV} ` +
      'or make a READY chat serving endpoint available to this user',
  );
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export type ServingCredentialSource = 'obo' | 'service-principal' | 'pat';

export interface ServingCredential {
  token: string;
  source: ServingCredentialSource;
}

export class DatabricksServingError extends Error {
  constructor(
    readonly code:
      | 'DATABRICKS_AUTH_REQUIRED'
      | 'DATABRICKS_HOST_MISSING'
      | 'DATABRICKS_SERVING_CONFIG'
      | 'DATABRICKS_SERVING_HTTP'
      | 'DATABRICKS_SERVING_STREAM',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DatabricksServingError';
  }
}

export interface ServicePrincipalTokenOptions {
  hostOrigin: string;
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  now?: () => number;
}

/**
 * OAuth M2M (client credentials) token source for the app service principal,
 * cached until shortly before expiry.
 */
export function createServicePrincipalTokenSource(options: ServicePrincipalTokenOptions) {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAtMs: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
    let response: Response;
    try {
      response = await fetchImpl(`${options.hostOrigin}/oidc/v1/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials&scope=all-apis',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new DatabricksServingError('DATABRICKS_AUTH_REQUIRED', 'Service principal token request failed');
    }
    if (!response.ok) {
      throw new DatabricksServingError(
        'DATABRICKS_AUTH_REQUIRED',
        `Service principal token request returned HTTP ${response.status}`,
        response.status,
      );
    }
    const body = (await response.json().catch(() => null)) as
      | { access_token?: unknown; expires_in?: unknown }
      | null;
    const token = typeof body?.access_token === 'string' ? body.access_token : '';
    if (!token) {
      throw new DatabricksServingError('DATABRICKS_AUTH_REQUIRED', 'Service principal token response had no access_token');
    }
    const ttlSec = typeof body?.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
    // Refresh a minute early so an in-flight agent turn never carries a token
    // that expires mid-request.
    cached = { token, expiresAtMs: now() + Math.max(0, ttlSec - 60) * 1000 };
    return token;
  }

  return {
    async getToken(): Promise<string> {
      if (cached && cached.expiresAtMs > now()) return cached.token;
      inflight ??= mint().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

export interface ResolveServingCredentialOptions {
  /** The signed-in user's OBO token for this run, when one exists. */
  userToken?: string | null;
  env?: NodeJS.ProcessEnv;
  servicePrincipal?: { getToken(): Promise<string> } | null;
}

/**
 * Choose the bearer token for a serving call.
 *
 *  1. The OBO user token (Unity Catalog governs the call as that user).
 *  2. The app service principal (`DATABRICKS_CLIENT_ID` / `_SECRET`).
 *  3. `DATABRICKS_TOKEN`, for local development against a real workspace.
 *
 * Returns null when none exists; callers must then refuse to call the
 * endpoint.
 */
export async function resolveServingCredential(
  options: ResolveServingCredentialOptions,
): Promise<ServingCredential | null> {
  const userToken = options.userToken?.trim();
  if (userToken) return { token: userToken, source: 'obo' };
  if (options.servicePrincipal) {
    const token = (await options.servicePrincipal.getToken()).trim();
    if (token) return { token, source: 'service-principal' };
  }
  const pat = (options.env ?? process.env).DATABRICKS_TOKEN?.trim();
  if (pat) return { token: pat, source: 'pat' };
  return null;
}

let processServicePrincipal: { key: string; source: ReturnType<typeof createServicePrincipalTokenSource> } | null = null;

/** The process-wide service-principal token source from env, or null. */
export function servicePrincipalFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): { getToken(): Promise<string> } | null {
  const hostOrigin = databricksHostOrigin(env);
  const clientId = env.DATABRICKS_CLIENT_ID?.trim();
  const clientSecret = env.DATABRICKS_CLIENT_SECRET?.trim();
  if (!hostOrigin || !clientId || !clientSecret) return null;
  if (fetchImpl) return createServicePrincipalTokenSource({ hostOrigin, clientId, clientSecret, fetch: fetchImpl });
  const key = `${hostOrigin}\n${clientId}`;
  if (processServicePrincipal?.key !== key) {
    processServicePrincipal = {
      key,
      source: createServicePrincipalTokenSource({ hostOrigin, clientId, clientSecret }),
    };
  }
  return processServicePrincipal.source;
}

// ---------------------------------------------------------------------------
// Chat Completions wire types (OpenAI-compatible subset)
// ---------------------------------------------------------------------------

export interface ServingToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ServingMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ServingToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ServingToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ServingUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/** One decoded unit of a streamed completion. */
export type ServingStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'usage'; usage: ServingUsage }
  | { type: 'finish'; reason: string | null };

export interface StreamChatRequest {
  endpoint: string;
  messages: ServingMessage[];
  tools?: ServingToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ServingEndpointSummary {
  name: string;
  task: string | null;
  ready: boolean;
}

export interface DatabricksServingClient {
  streamChat(request: StreamChatRequest): AsyncIterable<ServingStreamEvent>;
  listEndpoints(signal?: AbortSignal): Promise<ServingEndpointSummary[]>;
}

export interface DatabricksServingClientOptions {
  /** Workspace origin, e.g. `https://dbc-123.cloud.databricks.com`. */
  hostOrigin: string | null;
  /** Resolves the bearer for each call; null means "no credential". */
  getCredential: () => Promise<ServingCredential | null>;
  fetch?: FetchLike;
}

export function createDatabricksServingClient(
  options: DatabricksServingClientOptions,
): DatabricksServingClient {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function authorizedHeaders(): Promise<Record<string, string>> {
    if (!options.hostOrigin) {
      throw new DatabricksServingError(
        'DATABRICKS_HOST_MISSING',
        'DATABRICKS_HOST is not set; cannot reach Databricks Model Serving',
      );
    }
    const credential = await options.getCredential();
    if (!credential?.token) {
      throw new DatabricksServingError(
        'DATABRICKS_AUTH_REQUIRED',
        'No Databricks token is available for Model Serving (sign in through the Databricks App, ' +
          'or configure the app service principal)',
      );
    }
    return { Authorization: `Bearer ${credential.token}` };
  }

  return {
    async *streamChat(request) {
      const headers = await authorizedHeaders();
      const url = `${options.hostOrigin}/serving-endpoints/${encodeURIComponent(request.endpoint)}/invocations`;
      const body: Record<string, unknown> = {
        messages: request.messages,
        stream: true,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
      };
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(body),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (err) {
        if (request.signal?.aborted) throw err;
        throw new DatabricksServingError(
          'DATABRICKS_SERVING_HTTP',
          `Model Serving request to "${request.endpoint}" failed: ${(err as Error)?.message ?? String(err)}`,
        );
      }
      if (!response.ok) {
        throw new DatabricksServingError(
          'DATABRICKS_SERVING_HTTP',
          `Model Serving endpoint "${request.endpoint}" returned HTTP ${response.status}` +
            (await readErrorDetail(response)),
          response.status,
        );
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        // Some endpoints ignore `stream` and answer with a single completion.
        const json = await response.json().catch(() => null);
        yield* eventsFromCompletion(json);
        return;
      }
      if (!response.body) {
        throw new DatabricksServingError('DATABRICKS_SERVING_STREAM', 'Model Serving returned an empty response');
      }
      yield* decodeChatCompletionStream(response.body);
    },

    async listEndpoints(signal) {
      const headers = await authorizedHeaders();
      const response = await fetchImpl(`${options.hostOrigin}/api/2.0/serving-endpoints`, {
        method: 'GET',
        headers: { ...headers, Accept: 'application/json' },
        signal: signal ?? AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new DatabricksServingError(
          'DATABRICKS_SERVING_HTTP',
          `Listing serving endpoints returned HTTP ${response.status}`,
          response.status,
        );
      }
      const body = (await response.json().catch(() => null)) as { endpoints?: unknown } | null;
      const endpoints = Array.isArray(body?.endpoints) ? body.endpoints : [];
      const out: ServingEndpointSummary[] = [];
      for (const raw of endpoints as Array<Record<string, any>>) {
        if (typeof raw?.name !== 'string' || !raw.name) continue;
        out.push({
          name: raw.name,
          task: typeof raw.task === 'string' ? raw.task : null,
          ready: raw.state?.ready === 'READY',
        });
      }
      return out;
    },
  };
}

async function readErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return '';
  try {
    const json = JSON.parse(text) as { message?: unknown; error?: { message?: unknown } | unknown };
    const message =
      (typeof json.message === 'string' && json.message) ||
      (typeof (json.error as { message?: unknown })?.message === 'string' &&
        (json.error as { message: string }).message) ||
      (typeof json.error === 'string' && json.error) ||
      '';
    if (message) return `: ${message.slice(0, 500)}`;
  } catch {
    // fall through to the raw text
  }
  return `: ${text.slice(0, 500)}`;
}

function usageFromWire(raw: any): ServingUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : raw.input_tokens;
  const output = typeof raw.completion_tokens === 'number' ? raw.completion_tokens : raw.output_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return null;
  return {
    ...(typeof input === 'number' ? { input_tokens: input } : {}),
    ...(typeof output === 'number' ? { output_tokens: output } : {}),
  };
}

function* eventsFromChunk(chunk: any): Generator<ServingStreamEvent> {
  const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
  const delta = choice?.delta ?? choice?.message ?? null;
  if (delta) {
    const content = delta.content;
    if (typeof content === 'string' && content) {
      yield { type: 'text', delta: content };
    } else if (Array.isArray(content)) {
      // Claude-family endpoints may stream content as typed parts.
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
          yield { type: 'text', delta: part.text };
        } else if (part?.type === 'reasoning' && Array.isArray(part.summary)) {
          for (const summary of part.summary) {
            if (typeof summary?.text === 'string' && summary.text) yield { type: 'thinking', delta: summary.text };
          }
        }
      }
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      yield { type: 'thinking', delta: delta.reasoning_content };
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const [position, call] of delta.tool_calls.entries()) {
        yield {
          type: 'tool_call_delta',
          index: typeof call?.index === 'number' ? call.index : position,
          ...(typeof call?.id === 'string' && call.id ? { id: call.id } : {}),
          ...(typeof call?.function?.name === 'string' && call.function.name ? { name: call.function.name } : {}),
          argumentsDelta: typeof call?.function?.arguments === 'string' ? call.function.arguments : '',
        };
      }
    }
  }
  const usage = usageFromWire(chunk?.usage);
  if (usage) yield { type: 'usage', usage };
  if (choice && choice.finish_reason !== undefined && choice.finish_reason !== null) {
    yield { type: 'finish', reason: String(choice.finish_reason) };
  }
}

function* eventsFromCompletion(json: any): Generator<ServingStreamEvent> {
  if (!json || typeof json !== 'object') {
    throw new DatabricksServingError('DATABRICKS_SERVING_STREAM', 'Model Serving returned an unreadable response');
  }
  yield* eventsFromChunk(json);
}

/**
 * Decode an SSE body of Chat Completions chunks into stream events.
 *
 * Follows the SSE framing rules: an event is the `data:` lines up to the next
 * blank line, joined with `\n`, so a JSON payload split across several
 * `data:` lines parses. OpenAI-style streams (one `data:` line per event)
 * are the one-line case of the same rule. Other fields (`event:`, `id:`,
 * comments) are ignored.
 */
export async function* decodeChatCompletionStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServingStreamEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let dataLines: string[] = [];
  // Dispatch the accumulated event; true means the stream sent `[DONE]`.
  function* dispatch(): Generator<ServingStreamEvent, boolean> {
    if (dataLines.length === 0) return false;
    const data = dataLines.join('\n');
    dataLines = [];
    const event = parseSseData(data);
    if (event === 'done') return true;
    if (event) yield* eventsFromChunk(event);
    return false;
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (yield* dispatch()) return;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
        }
      }
      if (done) {
        const tail = buffer.replace(/\r$/, '');
        if (tail.startsWith('data:')) dataLines.push(tail.slice(tail.startsWith('data: ') ? 6 : 5));
        yield* dispatch();
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseData(raw: string): unknown | 'done' | null {
  const data = raw.trim();
  if (!data) return null;
  if (data === '[DONE]') return 'done';
  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new DatabricksServingError('DATABRICKS_SERVING_STREAM', 'Model Serving stream sent a malformed frame');
  }
  if (parsed?.error) {
    const message =
      typeof parsed.error === 'string' ? parsed.error : String(parsed.error?.message ?? 'stream error');
    throw new DatabricksServingError('DATABRICKS_SERVING_STREAM', `Model Serving stream error: ${message}`);
  }
  return parsed;
}
