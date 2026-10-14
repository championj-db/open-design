// End-to-end through the real run machinery: in Databricks auth mode the
// `databricks` agent is listed with the caller's serving endpoints, and a run
// spawns OpenDesign's harness, which calls Model Serving with the token of the
// user who started the run and writes into the project. A run nobody signed
// in for fails closed instead of borrowing another identity.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const APP_HOST = 'dbrx-open-design-123.aws.databricksapps.com';
const USER_TOKEN = 'obo-token-ada';

const chatRequests: Array<{ authorization: string; body: any }> = [];
let stub: Server;
let daemon: { url: string; server: Server; shutdown?: () => Promise<void> | void };
let chatTurn = 0;

function sseBody(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const authorization = String(req.headers.authorization ?? '');
      if (req.url === '/api/2.0/preview/scim/v2/Me') {
        if (authorization !== `Bearer ${USER_TOKEN}`) {
          res.statusCode = 401;
          return res.end('{}');
        }
        return res.end(JSON.stringify({ id: '42', userName: 'ada@example.com', displayName: 'Ada' }));
      }
      if (req.url === '/api/2.0/serving-endpoints') {
        return res.end(JSON.stringify({
          endpoints: [{
            name: 'databricks-claude-sonnet-4-5',
            task: 'llm/v1/chat',
            state: { ready: 'READY' },
            config: { served_entities: [{ foundation_model: { display_name: 'Claude Sonnet 4.5' } }] },
          }],
        }));
      }
      if (req.url === '/serving-endpoints/chat/completions') {
        chatRequests.push({ authorization, body: JSON.parse(raw) });
        res.setHeader('content-type', 'text/event-stream');
        const first = chatTurn++ % 2 === 0;
        return res.end(sseBody(first
          ? [
              { choices: [{ index: 0, delta: { content: 'Writing the page.' } }] },
              { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `toolu_${chatTurn}`, function: { name: 'Write', arguments: '{"file_path":"index.html","content":"<h1>Ada</h1>"}' } }] } }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
            ]
          : [
              { choices: [{ index: 0, delta: { content: 'Done.' } }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 150, completion_tokens: 2 } },
            ]));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));

  // The registry reads OD_AUTH_MODE when it loads, so set it before the server module.
  process.env.OD_AUTH_MODE = 'databricks';
  process.env.DATABRICKS_HOST = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  const { startServer } = await import('../src/server.js');
  daemon = (await startServer({ port: 0, host: '127.0.0.1', returnServer: true })) as typeof daemon;
});

afterAll(async () => {
  await Promise.resolve(daemon?.shutdown?.());
  if (daemon) await new Promise<void>((resolve) => daemon.server.close(() => resolve()));
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  delete process.env.OD_AUTH_MODE;
  delete process.env.DATABRICKS_HOST;
});

const asUser = { 'x-forwarded-host': APP_HOST, 'x-forwarded-access-token': USER_TOKEN };

async function createProject(): Promise<{ projectId: string; conversationId: string }> {
  const projectId = `dbx_run_${randomUUID().replace(/-/g, '')}`;
  const response = await fetch(`${daemon.url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...asUser },
    body: JSON.stringify({ id: projectId, name: 'Databricks run', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true }),
  });
  const body = (await response.json()) as { conversationId: string };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return { projectId, conversationId: body.conversationId };
}

async function startRun(headers: Record<string, string>, ids: { projectId: string; conversationId: string }) {
  const response = await fetch(`${daemon.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      ...ids,
      assistantMessageId: `assistant_${randomUUID()}`,
      clientRequestId: `client_${randomUUID()}`,
      agentId: 'databricks',
      model: 'databricks-claude-sonnet-4-5',
      message: 'Make a one-line page',
      currentPrompt: 'Make a one-line page',
    }),
  });
  const body = (await response.json()) as { runId?: string };
  expect(response.status, JSON.stringify(body)).toBe(202);
  return waitForRun(body.runId!, headers);
}

async function waitForRun(runId: string, headers: Record<string, string>) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const response = await fetch(`${daemon.url}/api/runs/${encodeURIComponent(runId)}`, { headers });
    const run = (await response.json()) as { status: string; error: string | null; errorCode: string | null };
    if (['failed', 'succeeded', 'canceled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${runId} did not finish`);
}

describe('Databricks agent runs', () => {
  it('lists the Databricks agent with the caller\'s serving endpoints', async () => {
    const response = await fetch(`${daemon.url}/api/agents`, { headers: asUser });
    const { agents } = (await response.json()) as { agents: Array<{ id: string; available: boolean; models: Array<{ id: string; label: string }> }> };
    const databricks = agents.find((agent) => agent.id === 'databricks');
    expect(databricks?.available).toBe(true);
    expect(databricks?.models).toEqual([
      { id: 'default', label: 'Default · Claude Sonnet 4.5' },
      { id: 'databricks-claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    ]);
    // OpenDesign Cloud needs its own sign-in, which a Databricks App refuses.
    expect(agents.some((agent) => agent.id === 'amr')).toBe(false);
  });

  it('generates into the project as the user who started the run', async () => {
    chatRequests.length = 0;
    const run = await startRun(asUser, await createProject());
    expect(run, JSON.stringify(run)).toMatchObject({ status: 'succeeded' });

    expect(chatRequests.length).toBeGreaterThanOrEqual(2);
    expect(chatRequests.every((request) => request.authorization === `Bearer ${USER_TOKEN}`)).toBe(true);
    expect(chatRequests[0]!.body.model).toBe('databricks-claude-sonnet-4-5');
    expect(chatRequests[0]!.body.messages.at(-1).content).toContain('Make a one-line page');

    const toolMessage = chatRequests[1]!.body.messages.find((message: any) => message.role === 'tool');
    const writtenPath = /at: (.+)$/.exec(toolMessage.content)?.[1];
    expect(writtenPath && existsSync(writtenPath)).toBe(true);
    expect(await readFile(writtenPath!, 'utf8')).toBe('<h1>Ada</h1>');
  });

  it('fails closed for a run no signed-in user started', async () => {
    chatRequests.length = 0;
    const ids = await createProject();
    // An in-container loopback caller: no proxy headers, so no user.
    const run = await startRun({}, ids);
    expect(run).toMatchObject({ status: 'failed', errorCode: 'DATABRICKS_AUTH_REQUIRED' });
    expect(chatRequests).toHaveLength(0);
  });
});
