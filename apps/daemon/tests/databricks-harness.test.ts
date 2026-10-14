// The Databricks agent harness: OpenDesign's own chat/tool loop against
// Model Serving's OpenAI-compatible chat completions, run as the signed-in
// user. Its stdout must read as Claude Code stream-json to the daemon's
// existing parser.

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databricksAgentForRequest } from '../src/databricks/agent-models.js';
import { runDatabricksHarness, type HarnessFrame } from '../src/databricks/harness-loop.js';
import { executeHarnessTool, globToRegExp, resolveInsideProject } from '../src/databricks/harness-tools.js';
import { bindDatabricksRequestContext } from '../src/databricks/request-context.js';
import type { DatabricksRuntime } from '../src/databricks/runtime.js';
import { chatEndpointsFromList, resolveDatabricksChatModel } from '../src/databricks/serving-endpoints.js';
import { createClaudeStreamHandler } from '../src/runtimes/claude-stream.js';
import type { DetectedAgent } from '../src/runtimes/types.js';

const HOST = 'https://example.cloud.databricks.com';

let projectDir = '';

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'od-dbx-harness-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const textChunk = (content: string) => ({ choices: [{ index: 0, delta: { role: 'assistant', content } }] });
const toolChunk = (call: Record<string, unknown>) => ({ choices: [{ index: 0, delta: { tool_calls: [call] } }] });
const finishChunk = (reason: string, usage = { prompt_tokens: 10, completion_tokens: 5 }) => ({
  choices: [{ index: 0, delta: { content: '' }, finish_reason: reason }],
  usage,
});

describe('Databricks harness tools', () => {
  it('confines paths to the project directory', async () => {
    await expect(resolveInsideProject(projectDir, 'a/b.html')).resolves.toMatch(/a\/b\.html$/);
    await expect(resolveInsideProject(projectDir, '../escape.html')).rejects.toThrow(/outside the project/);
    await expect(resolveInsideProject(projectDir, '/etc/passwd')).rejects.toThrow(/outside the project/);
    const outside = await mkdtemp(path.join(tmpdir(), 'od-dbx-outside-'));
    try {
      await symlink(outside, path.join(projectDir, 'link'));
      await expect(resolveInsideProject(projectDir, 'link/secret.txt')).rejects.toThrow(/resolves outside/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writes, edits, reads, globs and greps project files', async () => {
    const write = await executeHarnessTool(projectDir, 'Write', { file_path: 'pages/index.html', content: '<h1>Hi</h1>\n<p>x</p>' });
    expect(write.isError).toBe(false);

    const edit = await executeHarnessTool(projectDir, 'Edit', {
      file_path: path.join(projectDir, 'pages/index.html'),
      old_string: '<h1>Hi</h1>',
      new_string: '<h1>Hello</h1>',
    });
    expect(edit.isError).toBe(false);
    expect(await readFile(path.join(projectDir, 'pages/index.html'), 'utf8')).toBe('<h1>Hello</h1>\n<p>x</p>');

    const read = await executeHarnessTool(projectDir, 'Read', { file_path: 'pages/index.html', offset: 2 });
    expect(read.content).toBe('     2\t<p>x</p>');

    const glob = await executeHarnessTool(projectDir, 'Glob', { pattern: '**/*.html' });
    expect(glob.content).toContain('pages/index.html');

    const grep = await executeHarnessTool(projectDir, 'Grep', { pattern: 'Hello' });
    expect(grep.content).toMatch(/index\.html:1:<h1>Hello<\/h1>$/);

    const ambiguous = await executeHarnessTool(projectDir, 'Write', { file_path: 'a.txt', content: 'x x' })
      .then(() => executeHarnessTool(projectDir, 'Edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' }));
    expect(ambiguous).toMatchObject({ isError: true });
    expect(ambiguous.content).toMatch(/appears 2 times/);

    expect(await executeHarnessTool(projectDir, 'Bash', { command: 'ls' })).toMatchObject({ isError: true });
  });

  it('translates globs', () => {
    expect(globToRegExp('**/*.html').test('a/b/c.html')).toBe(true);
    expect(globToRegExp('**/*.html').test('c.html')).toBe(true);
    expect(globToRegExp('*.css').test('a/b.css')).toBe(false);
  });
});

describe('Databricks harness loop', () => {
  it('streams text, runs a tool, and finishes, as Claude stream-json', async () => {
    const requests: Array<{ url: string; headers: Headers; body: any }> = [];
    const turns = [
      sse([
        textChunk('Building '),
        textChunk('it.'),
        toolChunk({ index: 0, id: 'toolu_1', type: 'function', function: { name: 'Write', arguments: '' } }),
        toolChunk({ index: 0, function: { arguments: '{"file_path": "index.html", ' } }),
        toolChunk({ index: 0, function: { arguments: '"content": "<h1>Hi</h1>"}' } }),
        finishChunk('tool_calls'),
      ]),
      sse([textChunk('Done.'), finishChunk('stop', { prompt_tokens: 20, completion_tokens: 2 })]),
    ];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      requests.push({ url: String(input), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return turns.shift()!;
    }) as typeof fetch;

    const frames: HarnessFrame[] = [];
    await runDatabricksHarness({
      host: HOST,
      token: 'obo-user-token',
      model: 'databricks-claude-sonnet-4-5',
      projectDir,
      prompt: 'Make a page',
      emit: (frame) => frames.push(frame),
      fetchImpl,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe(`${HOST}/serving-endpoints/chat/completions`);
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer obo-user-token');
    expect(requests[0]!.body).toMatchObject({ model: 'databricks-claude-sonnet-4-5', stream: true });
    expect(requests[0]!.body.tools.map((t: any) => t.function.name)).toEqual(
      ['Write', 'Edit', 'Read', 'Glob', 'Grep', 'TodoWrite'],
    );
    const second = requests[1]!.body.messages;
    expect(second.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'toolu_1', function: { name: 'Write' } }] });
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'toolu_1' });
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('<h1>Hi</h1>');

    const events: any[] = [];
    const parser = createClaudeStreamHandler((event) => events.push(event));
    parser.feed(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''));
    parser.flush();

    const text = events.filter((event) => event.type === 'text_delta').map((event) => event.delta).join('');
    expect(text).toBe('Building it.Done.');
    expect(events.filter((event) => event.type === 'tool_use')).toEqual([
      expect.objectContaining({ id: 'toolu_1', name: 'Write', input: { file_path: 'index.html', content: '<h1>Hi</h1>' } }),
    ]);
    // The Write's arguments stream live (two argument chunks), not in one burst at the end.
    expect(events.filter((event) => event.type === 'tool_input_delta' && event.id === 'toolu_1').length).toBeGreaterThanOrEqual(2);
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ toolUseId: 'toolu_1', isError: false });
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      stopReason: 'end_turn',
      usage: { input_tokens: 30, output_tokens: 7 },
    });
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('offers Bash only with a sandbox shell and routes its calls there', async () => {
    const bodies: any[] = [];
    const turns = [
      sse([
        toolChunk({ index: 0, id: 'toolu_b', type: 'function', function: { name: 'Bash', arguments: '{"command": "python3 build.py"}' } }),
        finishChunk('tool_calls'),
      ]),
      sse([textChunk('Built.'), finishChunk('stop')]),
    ];
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      bodies.push(JSON.parse(String(init.body)));
      return turns.shift()!;
    }) as typeof fetch;
    const commands: unknown[] = [];
    const shell = {
      async execute(input: Record<string, unknown>) {
        commands.push(input.command);
        return { content: 'ok', isError: false };
      },
    };
    await runDatabricksHarness({ host: HOST, token: 't', model: 'm', projectDir, prompt: 'p', emit: () => {}, fetchImpl, shell });
    expect(bodies[0].tools.map((t: any) => t.function.name)).toContain('Bash');
    expect(bodies[0].messages[0].content).toContain('Bash tool runs commands in your own isolated sandbox');
    expect(commands).toEqual(['python3 build.py']);
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'toolu_b', content: 'ok' });
  });

  it('retries once without max_tokens when the endpoint rejects the request shape', async () => {
    const bodies: any[] = [];
    const responses = [
      new Response('{"message":"max_tokens too large"}', { status: 400 }),
      sse([textChunk('ok'), finishChunk('stop')]),
    ];
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      bodies.push(JSON.parse(String(init.body)));
      return responses.shift()!;
    }) as typeof fetch;
    await runDatabricksHarness({ host: HOST, token: 't', model: 'm', projectDir, prompt: 'p', emit: () => {}, fetchImpl });
    expect(bodies[0].max_tokens).toBe(32_000);
    expect(bodies[1].max_tokens).toBeUndefined();
  });

  it('explains a rejected session and an inaccessible endpoint', async () => {
    const respond = (status: number) => (async () => new Response('{}', { status })) as typeof fetch;
    const run = (status: number) =>
      runDatabricksHarness({ host: HOST, token: 't', model: 'secret-ep', projectDir, prompt: 'p', emit: () => {}, fetchImpl: respond(status) });
    await expect(run(401)).rejects.toThrow(/rejected your session token/);
    await expect(run(403)).rejects.toThrow(/do not have access to the serving endpoint "secret-ep"/);
  });
});

describe('Databricks harness entry point', () => {
  const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/databricks/agent-harness.js');

  async function runEntry(env: NodeJS.ProcessEnv, stdin: string): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [ENTRY, '--model', 'databricks-gpt-5'], { cwd: projectDir, env, timeout: 15_000 }, (error, stdout) => {
        resolve({ stdout, code: error ? Number((error as { code?: number }).code ?? 1) : 0 });
      });
      child.stdin!.end(stdin);
    });
  }

  it('calls Model Serving with the injected user token and writes into its cwd', async () => {
    const seen: Array<{ authorization: string | undefined; model: string }> = [];
    let turn = 0;
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        seen.push({ authorization: req.headers.authorization, model: JSON.parse(raw).model });
        res.setHeader('content-type', 'text/event-stream');
        const chunks = turn++ === 0
          ? [toolChunk({ index: 0, id: 'toolu_x', function: { name: 'Write', arguments: '{"file_path":"out.html","content":"ok"}' } }), finishChunk('tool_calls')]
          : [textChunk('done'), finishChunk('stop')];
        res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const result = await runEntry(
        { PATH: process.env.PATH, DATABRICKS_HOST: `http://127.0.0.1:${port}`, DATABRICKS_TOKEN: 'user-obo' },
        'Write out.html',
      );
      expect(result.code).toBe(0);
      expect(seen).toEqual([
        { authorization: 'Bearer user-obo', model: 'databricks-gpt-5' },
        { authorization: 'Bearer user-obo', model: 'databricks-gpt-5' },
      ]);
      expect(await readFile(path.join(projectDir, 'out.html'), 'utf8')).toBe('ok');
      const lastFrame = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      expect(lastFrame).toMatchObject({ type: 'result', is_error: false });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fails closed without a user token', async () => {
    const result = await runEntry({ PATH: process.env.PATH, DATABRICKS_HOST: HOST }, 'hi');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      type: 'result',
      is_error: true,
      errors: [expect.stringMatching(/No Databricks user session/)],
    });
  });
});

describe('Databricks models', () => {
  const listing = {
    endpoints: [
      { name: 'databricks-claude-sonnet-4-5', task: 'llm/v1/chat', state: { ready: 'READY' }, config: { served_entities: [{ foundation_model: { display_name: 'Claude Sonnet 4.5' } }] } },
      { name: 'custom-agent', task: 'llm/v1/chat', state: { ready: 'READY' } },
      { name: 'not-ready', task: 'llm/v1/chat', state: { ready: 'NOT_READY' } },
      { name: 'embeddings', task: 'llm/v1/embeddings', state: { ready: 'READY' } },
    ],
  };

  it('keeps only ready chat endpoints', () => {
    expect(chatEndpointsFromList(listing)).toEqual([
      { name: 'databricks-claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' },
      { name: 'custom-agent', displayName: 'custom-agent' },
    ]);
  });

  it('resolves the default model', () => {
    expect(resolveDatabricksChatModel('default', {})).toBe('databricks-claude-sonnet-4-5');
    expect(resolveDatabricksChatModel(null, { OD_DATABRICKS_DEFAULT_MODEL: 'databricks-gpt-5' })).toBe('databricks-gpt-5');
    expect(resolveDatabricksChatModel('custom-agent', {})).toBe('custom-agent');
  });

  it('lists the caller\'s endpoints as the Databricks agent\'s models', async () => {
    const auth: string[] = [];
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      auth.push(new Headers(init.headers).get('authorization') ?? '');
      return new Response(JSON.stringify(listing));
    }) as typeof fetch;
    const runtime = { host: HOST, identity: { resolve: async () => { throw new Error('unused'); } }, servicePrincipal: null } as DatabricksRuntime;
    const agent = { id: 'databricks', models: [{ id: 'default', label: 'Default' }], modelsSource: 'fallback' } as unknown as DetectedAgent;
    const req = {};
    bindDatabricksRequestContext(req, {
      user: { id: '1', userName: 'ada@example.com', displayName: null, email: null, groups: [] },
      accessToken: 'obo',
    });

    const decorated = await databricksAgentForRequest(runtime, agent, req, fetchImpl);
    expect(decorated.models).toEqual([
      { id: 'default', label: 'Default · Claude Sonnet 4.5' },
      { id: 'databricks-claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { id: 'custom-agent', label: 'custom-agent' },
    ]);
    expect(decorated.modelsSource).toBe('live');
    expect(auth).toEqual(['Bearer obo']);

    expect(await databricksAgentForRequest(runtime, agent, {}, fetchImpl)).toBe(agent);
    const other = { ...agent, id: 'claude' } as DetectedAgent;
    expect(await databricksAgentForRequest(runtime, other, req, fetchImpl)).toBe(other);
  });
});
