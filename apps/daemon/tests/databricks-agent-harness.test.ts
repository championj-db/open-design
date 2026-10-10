import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachDatabricksAgentSession,
  createInProcessAgentChild,
  createLocalExecutor,
} from '../src/agent-protocol/databricks/index.js';
import type { DatabricksHarnessEvent } from '../src/agent-protocol/databricks/harness.js';
import {
  createDatabricksServingClient,
  resolveServingCredential,
} from '../src/integrations/databricks-serving.js';

const HOST = 'https://dbc-test.cloud.databricks.com';

type RecordedRequest = { url: string; headers: Record<string, string>; body: any };

function sse(frames: unknown[]): string {
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;
}

/** A mock Model Serving endpoint: answers each invocation with the next scripted SSE body. */
function mockServing(turns: Array<string | { status: number; body: string }>) {
  const requests: RecordedRequest[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    requests.push({ url, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = turns.shift();
    if (next === undefined) throw new Error('unexpected extra serving request');
    if (typeof next !== 'string') return new Response(next.body, { status: next.status });
    // Split into small chunks so the decoder has to reassemble frames.
    const bytes = new TextEncoder().encode(next);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, requests };
}

const textChunk = (content: string) => ({ choices: [{ index: 0, delta: { content } }] });

describe('Databricks in-process agent harness', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'od-dbx-harness-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  async function run(
    turns: Parameters<typeof mockServing>[0],
    opts: { userToken?: string | null; env?: NodeJS.ProcessEnv; model?: string | null } = {},
  ) {
    const serving = mockServing(turns);
    const events: DatabricksHarnessEvent[] = [];
    const child = createInProcessAgentChild();
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    const result = await attachDatabricksAgentSession({
      child,
      prompt: 'Build a landing page',
      cwd,
      model: opts.model ?? null,
      env: opts.env ?? { DATABRICKS_HOST: HOST, OD_DATABRICKS_SERVING_ENDPOINT: 'databricks-claude-test' },
      userToken: opts.userToken === undefined ? 'user-obo-token' : opts.userToken,
      emit: (event) => events.push(event),
      fetch: serving.fetch,
      executor: createLocalExecutor({ cwd }),
    });
    return { result, events, requests: serving.requests, exit: await closed };
  }

  it('streams a plain text answer as text_delta events and closes the child with code 0', async () => {
    const { result, events, requests, exit } = await run([
      sse([
        textChunk('Hello'),
        textChunk(', world'),
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } },
      ]),
    ]);
    expect(result.status).toBe('succeeded');
    expect(exit).toEqual({ code: 0, signal: null });
    expect(events).toEqual([
      { type: 'status', label: 'requesting', model: 'databricks-claude-test' },
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ', world' },
      {
        type: 'usage',
        usage: { input_tokens: 12, output_tokens: 3 },
        durationMs: expect.any(Number),
        stopReason: 'end_turn',
      },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${HOST}/serving-endpoints/databricks-claude-test/invocations`);
    expect(requests[0]!.body.stream).toBe(true);
    expect(requests[0]!.body.messages.at(-1)).toEqual({ role: 'user', content: 'Build a landing page' });
    expect(requests[0]!.body.tools.map((t: any) => t.function.name)).toEqual(['Read', 'Write', 'Edit', 'LS', 'Bash']);
  });

  it('runs a full tool_use -> execute -> tool_result -> final answer loop', async () => {
    const args = JSON.stringify({ file_path: 'index.html', content: '<h1>Hi</h1>' });
    const { result, events, requests } = await run([
      sse([
        textChunk('Writing the page.'),
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Write', arguments: '' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 10) } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8 } },
      ]),
      sse([
        textChunk('Done.'),
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 2 } },
      ]),
    ]);
    expect(result.status).toBe('succeeded');
    expect(readFileSync(path.join(cwd, 'index.html'), 'utf8')).toBe('<h1>Hi</h1>');

    const kinds = events.map((event) => event.type);
    expect(kinds).toEqual([
      'status',
      'text_delta',
      'tool_in_flight',
      'tool_input_delta',
      'tool_input_delta',
      'tool_use',
      'tool_result',
      'text_delta',
      'usage',
    ]);
    expect(events.find((e) => e.type === 'tool_use')).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'Write',
      input: { file_path: 'index.html', content: '<h1>Hi</h1>' },
    });
    expect(events.find((e) => e.type === 'tool_result')).toEqual({
      type: 'tool_result',
      toolUseId: 'call_1',
      content: 'Wrote 1 lines to index.html',
      isError: false,
      completedAt: expect.any(Number),
    });
    expect(events.at(-1)).toMatchObject({ type: 'usage', usage: { input_tokens: 60, output_tokens: 10 } });

    // The second turn carries the assistant tool call and the tool result back.
    const second = requests[1]!.body.messages;
    expect(second.at(-2)).toEqual({
      role: 'assistant',
      content: 'Writing the page.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Write', arguments: args } }],
    });
    expect(second.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'Wrote 1 lines to index.html' });
  });

  it('reports tool failures as isError tool_result and keeps looping', async () => {
    writeFileSync(path.join(cwd, 'a.txt'), 'x');
    const { result, events } = await run([
      sse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"file_path":"../outside.txt"}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]),
      sse([textChunk('ok'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]),
    ]);
    expect(result.status).toBe('succeeded');
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      toolUseId: 'c1',
      isError: true,
      content: expect.stringContaining('outside the project directory'),
    });
  });

  it('maps a serving HTTP failure to an error event, usage, and exit code 1', async () => {
    const { result, events, exit } = await run([
      { status: 403, body: JSON.stringify({ message: 'PERMISSION_DENIED: no access to endpoint' }) },
    ]);
    expect(result.status).toBe('failed');
    expect(exit).toEqual({ code: 1, signal: null });
    expect(events.at(-2)).toMatchObject({ type: 'usage', stopReason: 'error' });
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'DATABRICKS_SERVING_HTTP',
      message: expect.stringContaining('HTTP 403: PERMISSION_DENIED: no access to endpoint'),
    });
  });

  it('maps an in-stream error frame to an error event', async () => {
    const { result, events } = await run([
      `data: ${JSON.stringify(textChunk('partial'))}\n\ndata: ${JSON.stringify({ error: { message: 'rate limited' } })}\n\n`,
    ]);
    expect(result.status).toBe('failed');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'DATABRICKS_SERVING_STREAM', message: expect.stringContaining('rate limited') });
  });

  it('sends the OBO user token as the bearer when present', async () => {
    const { requests } = await run(
      [sse([textChunk('hi'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])],
      { userToken: 'user-obo-token', env: { DATABRICKS_HOST: HOST, DATABRICKS_TOKEN: 'dev-pat' } },
    );
    expect(requests[0]!.headers.Authorization).toBe('Bearer user-obo-token');
  });

  it('fails closed: no request is made without a bearer token', async () => {
    const { result, events, requests, exit } = await run(
      [sse([textChunk('should not be sent')])],
      { userToken: null, env: { DATABRICKS_HOST: HOST } },
    );
    expect(requests).toHaveLength(0);
    expect(result.status).toBe('failed');
    expect(exit.code).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'DATABRICKS_AUTH_REQUIRED' });
  });

  it('uses the selected model as the serving endpoint name', async () => {
    const { requests } = await run(
      [sse([textChunk('hi'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])],
      { model: 'databricks-meta-llama-3-3-70b-instruct' },
    );
    expect(requests[0]!.url).toBe(`${HOST}/serving-endpoints/databricks-meta-llama-3-3-70b-instruct/invocations`);
  });

  it('kill() aborts the loop and closes the child with the signal', async () => {
    const child = createInProcessAgentChild();
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    const fetch = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const pending = attachDatabricksAgentSession({
      child,
      prompt: 'x',
      cwd,
      model: null,
      env: { DATABRICKS_HOST: HOST },
      userToken: 'tok',
      emit: () => {},
      fetch,
    });
    setTimeout(() => child.kill('SIGTERM'), 5);
    expect((await pending).status).toBe('canceled');
    expect(await closed).toEqual({ code: null, signal: 'SIGTERM' });
  });
});

describe('Databricks serving credentials', () => {
  it('prefers the OBO user token over the service principal and PAT', async () => {
    const sp = { getToken: async () => 'sp-token' };
    await expect(
      resolveServingCredential({ userToken: 'obo', servicePrincipal: sp, env: { DATABRICKS_TOKEN: 'pat' } }),
    ).resolves.toEqual({ token: 'obo', source: 'obo' });
    await expect(
      resolveServingCredential({ userToken: null, servicePrincipal: sp, env: { DATABRICKS_TOKEN: 'pat' } }),
    ).resolves.toEqual({ token: 'sp-token', source: 'service-principal' });
    await expect(
      resolveServingCredential({ userToken: null, servicePrincipal: null, env: { DATABRICKS_TOKEN: 'pat' } }),
    ).resolves.toEqual({ token: 'pat', source: 'pat' });
    await expect(resolveServingCredential({ userToken: null, env: {} })).resolves.toBeNull();
  });

  it('lists serving endpoints with the bearer token', async () => {
    const seen: string[] = [];
    const client = createDatabricksServingClient({
      hostOrigin: HOST,
      getCredential: async () => ({ token: 'obo', source: 'obo' }),
      fetch: async (url, init) => {
        seen.push(`${url} ${(init?.headers as Record<string, string>).Authorization}`);
        return Response.json({
          endpoints: [
            { name: 'databricks-claude-sonnet-4-5', task: 'llm/v1/chat', state: { ready: 'READY' } },
            { name: 'embeddings', task: 'llm/v1/embeddings', state: { ready: 'READY' } },
          ],
        });
      },
    });
    await expect(client.listEndpoints()).resolves.toEqual([
      { name: 'databricks-claude-sonnet-4-5', task: 'llm/v1/chat', ready: true },
      { name: 'embeddings', task: 'llm/v1/embeddings', ready: true },
    ]);
    expect(seen).toEqual([`${HOST}/api/2.0/serving-endpoints Bearer obo`]);
  });
});
