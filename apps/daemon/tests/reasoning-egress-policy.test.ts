import type http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/server.js';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const realFetch = globalThis.fetch;

function sseResponse(body: string): Response {
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('reasoningExecution egress policy', () => {
  let baseUrl: string;
  let server: http.Server | null = null;

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  }));

  function stubUnexpectedUpstreamFetch() {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      throw new Error(`unexpected upstream fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return realFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function expectReasoningDenied(
    path: string,
    body: Record<string, unknown>,
    expected: { routeKind: string; provider: string; code?: string; status?: number },
  ) {
    const fetchMock = stubUnexpectedUpstreamFetch();
    const res = await postJson(path, body);
    expect(res.status).toBe(expected.status ?? 403);
    const payload = await res.json() as {
      error: {
        code: string;
        data: Record<string, unknown>;
      };
    };
    expect(payload.error.code).toBe(expected.code ?? 'reasoning_execution_disabled');
    expect(payload.error.data).toMatchObject({
      routeKind: expected.routeKind,
      provider: expected.provider,
    });
    if (typeof body.apiKey === 'string') {
      expect(JSON.stringify(payload)).not.toContain(body.apiKey);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  }

  const disabledPolicy = { mode: 'disabled' };

  it('blocks disabled finalize egress before project lookup or upstream fetch', async () => {
    await expectReasoningDenied(
      '/api/projects/project-1/finalize/openai',
      {
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai',
        model: 'gpt-test',
        reasoningExecution: disabledPolicy,
      },
      { routeKind: 'finalize', provider: 'openai' },
    );
  });

});
