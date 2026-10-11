import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_EXECUTION_SANDBOX_REQUIRED_MESSAGE,
  attachDatabricksAgentSession,
  createInProcessAgentChild,
  createLocalExecutor,
} from '../src/agent-protocol/databricks/index.js';
import type { DatabricksHarnessEvent } from '../src/agent-protocol/databricks/harness.js';
import {
  createDatabricksServingClient,
  decodeChatCompletionStream,
  resolveServingCredential,
  resolveServingEndpoint,
} from '../src/integrations/databricks-serving.js';
import { servingEndpointModels } from '../src/runtimes/defs/databricks.js';

const HOST = 'https://dbc-test.cloud.databricks.com';

type RecordedRequest = { url: string; headers: Record<string, string>; body: any };

function sse(frames: unknown[]): string {
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;
}

/** A mock Model Serving endpoint: answers each invocation with the next scripted SSE body. */
function mockServing(turns: Array<string | { status: number; body: string; contentType?: string }>) {
  const requests: RecordedRequest[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    requests.push({ url, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = turns.shift();
    if (next === undefined) throw new Error('unexpected extra serving request');
    if (typeof next !== 'string') {
      return new Response(next.body || null, {
        status: next.status,
        ...(next.contentType ? { headers: { 'content-type': next.contentType } } : {}),
      });
    }
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
      {
        userToken: 'user-obo-token',
        env: { DATABRICKS_HOST: HOST, DATABRICKS_TOKEN: 'dev-pat', OD_DATABRICKS_SERVING_ENDPOINT: 'e' },
      },
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

  it('refuses model tool calls that reach outside the project or run shell, and keeps looping', async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'od-dbx-outside-'));
    writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret');
    try {
      const callFrame = (id: string, name: string, args: unknown) => ({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }],
      });
      const { result, events } = await run([
        sse([callFrame('r1', 'Read', { file_path: path.join(outsideDir, 'secret.txt') }), { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]),
        sse([callFrame('w1', 'Write', { file_path: path.join(outsideDir, 'pwn.txt'), content: 'x' }), { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]),
        sse([callFrame('b1', 'Bash', { command: `cat ${path.join(outsideDir, 'secret.txt')}` }), { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]),
        sse([textChunk('ok'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]),
      ]);
      expect(result.status).toBe('succeeded');
      const results = events.filter((e) => e.type === 'tool_result');
      expect(results).toEqual([
        expect.objectContaining({ toolUseId: 'r1', isError: true, content: expect.stringContaining('outside the project directory') }),
        expect.objectContaining({ toolUseId: 'w1', isError: true, content: expect.stringContaining('outside the project directory') }),
        expect.objectContaining({ toolUseId: 'b1', isError: true, content: CODE_EXECUTION_SANDBOX_REQUIRED_MESSAGE }),
      ]);
      expect(results.some((e) => JSON.stringify(e).includes('top secret'))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['an empty event-stream body', ''],
    ['only [DONE]', 'data: [DONE]\n\n'],
  ])('fails an HTTP 200 with %s instead of reporting an empty success', async (_label, body) => {
    const { result, events, exit } = await run([body]);
    expect(result.status).toBe('failed');
    expect(exit.code).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'DATABRICKS_SERVING_STREAM' });
  });

  it('fails an HTTP 200 JSON completion with no choices', async () => {
    const { result, events } = await run([{ status: 200, body: '{}', contentType: 'application/json' }]);
    expect(result.status).toBe('failed');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'DATABRICKS_SERVING_STREAM' });
  });

  it('discovers a READY chat endpoint when none is configured', async () => {
    const serving = mockServing([sse([textChunk('hi'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])]);
    const requests: string[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (url.endsWith('/api/2.0/serving-endpoints')) {
        return Response.json({
          endpoints: [
            { name: 'databricks-claude-down', task: 'llm/v1/chat', state: { ready: 'NOT_READY' } },
            { name: 'embeddings', task: 'llm/v1/embeddings', state: { ready: 'READY' } },
            { name: 'databricks-llama', task: 'llm/v1/chat', state: { ready: 'READY' } },
          ],
        });
      }
      return serving.fetch(url, init);
    };
    const child = createInProcessAgentChild();
    const result = await attachDatabricksAgentSession({
      child, prompt: 'x', cwd, model: null, env: { DATABRICKS_HOST: HOST }, userToken: 'tok',
      emit: () => {}, fetch, executor: createLocalExecutor({ cwd }),
    });
    expect(result.status).toBe('succeeded');
    expect(requests.at(-1)).toBe(`${HOST}/serving-endpoints/databricks-llama/invocations`);
  });

  it('fails with a configuration error when no endpoint is configured or READY', async () => {
    const events: DatabricksHarnessEvent[] = [];
    const child = createInProcessAgentChild();
    const result = await attachDatabricksAgentSession({
      child, prompt: 'x', cwd, model: null, env: { DATABRICKS_HOST: HOST }, userToken: 'tok',
      emit: (e) => events.push(e),
      fetch: async () => Response.json({ endpoints: [{ name: 'c', task: 'llm/v1/chat', state: { ready: 'NOT_READY' } }] }),
      executor: createLocalExecutor({ cwd }),
    });
    expect(result.status).toBe('failed');
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'DATABRICKS_SERVING_CONFIG',
      message: expect.stringContaining('OD_DATABRICKS_SERVING_ENDPOINT'),
    });
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

describe('Databricks serving endpoint selection', () => {
  const list = (endpoints: Array<{ name: string; task: string | null; ready: boolean }>) => ({
    listEndpoints: async () => endpoints,
  });

  it('prefers the selected model, then the env var, then a READY chat endpoint (Claude first)', async () => {
    const client = list([
      { name: 'databricks-llama', task: 'llm/v1/chat', ready: true },
      { name: 'databricks-claude-x', task: 'llm/v1/chat', ready: true },
    ]);
    await expect(resolveServingEndpoint({ model: 'picked', env: { OD_DATABRICKS_SERVING_ENDPOINT: 'env' }, client })).resolves.toBe('picked');
    await expect(resolveServingEndpoint({ model: 'default', env: { OD_DATABRICKS_SERVING_ENDPOINT: 'env' }, client })).resolves.toBe('env');
    await expect(resolveServingEndpoint({ model: null, env: {}, client })).resolves.toBe('databricks-claude-x');
  });

  it('lists only READY chat endpoints as selectable models', () => {
    const models = servingEndpointModels(
      [
        { name: 'databricks-claude-down', task: 'llm/v1/chat', ready: false },
        { name: 'databricks-llama', task: 'llm/v1/chat', ready: true },
        { name: 'external', task: null, ready: true },
        { name: 'embeddings', task: 'llm/v1/embeddings', ready: true },
      ],
      {},
    );
    expect(models.map((m) => m.id)).toEqual(['default', 'databricks-llama', 'external']);
    expect(models.some((m) => /not ready/i.test(m.label))).toBe(false);
  });
});

describe('Databricks SSE decoding', () => {
  async function decode(text: string) {
    const body = new Response(text).body!;
    const out: unknown[] = [];
    for await (const event of decodeChatCompletionStream(body)) out.push(event);
    return out;
  }

  it('joins multi-line data: fields up to the blank-line delimiter', async () => {
    const frame = JSON.stringify(textChunk('multi'), null, 2).split('\n').map((line) => `data: ${line}`).join('\n');
    await expect(decode(`event: message\n${frame}\n\n${frame}\r\n\r\ndata: [DONE]\n\n`)).resolves.toEqual([
      { type: 'text', delta: 'multi' },
      { type: 'text', delta: 'multi' },
    ]);
  });

  it('still decodes one-line OpenAI frames, including a final frame with no trailing newline', async () => {
    await expect(decode(`data: ${JSON.stringify(textChunk('a'))}\n\ndata:${JSON.stringify(textChunk('b'))}`)).resolves.toEqual([
      { type: 'text', delta: 'a' },
      { type: 'text', delta: 'b' },
    ]);
  });
});
