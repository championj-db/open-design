import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { executeHarnessTool, HARNESS_TOOLS } from './harness-tools.js';

// The Databricks agent harness: OpenDesign's own chat/tool loop, run against
// the workspace's Model Serving endpoints (OpenAI-compatible
// `/serving-endpoints/chat/completions`) with the signed-in user's
// on-behalf-of token, so endpoint permissions, AI Gateway policies and usage
// attribution all apply to that user.
//
// It speaks Claude Code's stream-json on stdout (system/init, stream_event
// deltas, assistant / user wrappers, result) so the daemon's existing Claude
// parser turns it into the same run events, and the web renders the
// execution record without a parser of its own.

export type HarnessFrame = Record<string, unknown>;

export interface DatabricksHarnessOptions {
  /** Workspace origin, e.g. `https://<workspace>.cloud.databricks.com`. */
  host: string;
  /** The user's on-behalf-of token. Never logged or written anywhere. */
  token: string;
  /** Serving endpoint name. */
  model: string;
  projectDir: string;
  /** The daemon-composed prompt (system instructions, history, user request). */
  prompt: string;
  imagePaths?: string[];
  emit: (frame: HarnessFrame) => void;
  fetchImpl?: typeof fetch;
  maxTurns?: number;
  maxTokens?: number;
  now?: () => number;
}

export class DatabricksHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabricksHarnessError';
  }
}

const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_TOKENS = 32_000;

interface StreamedToolCall {
  id: string;
  name: string;
  arguments: string;
  /** Content-block index once the call has a name and its block opened. */
  blockIndex: number | null;
  closed: boolean;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function harnessEnvironmentNote(projectDir: string): string {
  return [
    'You are running inside OpenDesign on Databricks, on behalf of the signed-in user.',
    `Your working directory is the project directory: ${projectDir}`,
    'Use the Write, Edit, Read, Glob, Grep and TodoWrite tools to inspect and create files there.',
    'Paths may be absolute inside that directory or relative to it.',
    'There is no shell: you cannot run commands or install packages, so do the work with the file tools.',
  ].join('\n');
}

export async function runDatabricksHarness(options: DatabricksHarnessOptions): Promise<void> {
  const {
    host,
    token,
    model,
    projectDir,
    prompt,
    emit,
    fetchImpl = fetch,
    maxTurns = DEFAULT_MAX_TURNS,
    now = Date.now,
  } = options;
  const startedAt = now();
  const sessionId = randomUUID();
  const usage = { input_tokens: 0, output_tokens: 0 };
  let maxTokens: number | null = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model,
    cwd: projectDir,
    tools: HARNESS_TOOLS.map((entry) => entry.function.name),
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: harnessEnvironmentNote(projectDir) },
    { role: 'user', content: await userContent(prompt, options.imagePaths ?? []) },
  ];
  let finalText = '';

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const messageId = `msg_${sessionId.replace(/-/g, '').slice(0, 16)}_${turn}`;
    emit(streamEvent(sessionId, { type: 'message_start', message: { id: messageId, role: 'assistant', model, content: [] } }));

    let response = await requestCompletion(fetchImpl, host, token, model, messages, maxTokens);
    if (response.status === 400 && maxTokens !== null) {
      // Some endpoints cap output below our default; retry once with the
      // endpoint's own limit rather than failing the turn.
      await response.text().catch(() => '');
      maxTokens = null;
      response = await requestCompletion(fetchImpl, host, token, model, messages, maxTokens);
    }
    await assertOk(response, model);

    let text = '';
    const toolCalls = new Map<number, StreamedToolCall>();
    let turnUsage = { input_tokens: 0, output_tokens: 0 };
    let finishReason: string | null = null;
    // Content blocks are emitted as they stream, one open at a time, the way
    // Claude Code does, so a long Write shows up live instead of all at once.
    let openBlock: { index: number; toolIndex: number | null } | null = null;
    let nextBlockIndex = 0;
    const closeOpenBlock = () => {
      if (!openBlock) return;
      emit(streamEvent(sessionId, { type: 'content_block_stop', index: openBlock.index }));
      if (openBlock.toolIndex !== null) toolCalls.get(openBlock.toolIndex)!.closed = true;
      openBlock = null;
    };

    for await (const chunk of sseJson(response)) {
      if (isRecord(chunk.usage)) {
        turnUsage = {
          input_tokens: numberOr(chunk.usage.prompt_tokens, turnUsage.input_tokens),
          output_tokens: numberOr(chunk.usage.completion_tokens, turnUsage.output_tokens),
        };
      }
      if (typeof chunk.error_code === 'string' || isRecord(chunk.error)) {
        throw new DatabricksHarnessError(`Model Serving stream error: ${JSON.stringify(chunk.error ?? chunk.message ?? chunk.error_code)}`);
      }
      const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : null;
      if (!choice) continue;
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      const piece = deltaText(delta.content);
      if (piece) {
        if (!openBlock || openBlock.toolIndex !== null) {
          closeOpenBlock();
          openBlock = { index: nextBlockIndex++, toolIndex: null };
          emit(streamEvent(sessionId, { type: 'content_block_start', index: openBlock.index, content_block: { type: 'text', text: '' } }));
        }
        text += piece;
        emit(streamEvent(sessionId, { type: 'content_block_delta', index: openBlock.index, delta: { type: 'text_delta', text: piece } }));
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const part of delta.tool_calls.filter(isRecord)) {
          const toolIndex = typeof part.index === 'number' ? part.index : toolCalls.size;
          const call = toolCalls.get(toolIndex) ?? { id: '', name: '', arguments: '', blockIndex: null, closed: false };
          toolCalls.set(toolIndex, call);
          if (typeof part.id === 'string' && part.id) call.id = part.id;
          const fn = isRecord(part.function) ? part.function : {};
          if (typeof fn.name === 'string' && fn.name) call.name = fn.name;
          const argumentsPiece = typeof fn.arguments === 'string' ? fn.arguments : '';
          call.arguments += argumentsPiece;
          if (call.blockIndex === null && call.name) {
            call.id ||= `toolu_${randomUUID().replace(/-/g, '')}`;
            closeOpenBlock();
            call.blockIndex = nextBlockIndex++;
            openBlock = { index: call.blockIndex, toolIndex };
            emit(streamEvent(sessionId, { type: 'content_block_start', index: call.blockIndex, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }));
            if (call.arguments) {
              emit(streamEvent(sessionId, { type: 'content_block_delta', index: call.blockIndex, delta: { type: 'input_json_delta', partial_json: call.arguments } }));
            }
          } else if (argumentsPiece && openBlock?.toolIndex === toolIndex && !call.closed) {
            emit(streamEvent(sessionId, { type: 'content_block_delta', index: call.blockIndex!, delta: { type: 'input_json_delta', partial_json: argumentsPiece } }));
          }
          // Arguments for a call whose block already closed (interleaved
          // streams) still accumulate; the assistant wrapper below carries
          // the complete input for the parser.
        }
      }
    }
    closeOpenBlock();

    const calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call)
      .filter((call) => call.name !== '');
    const parsedInputs = calls.map((call) => parseArguments(call.arguments));

    usage.input_tokens += turnUsage.input_tokens;
    usage.output_tokens += turnUsage.output_tokens;
    const stopReason = calls.length > 0 ? 'tool_use' : finishReason === 'length' ? 'max_tokens' : 'end_turn';
    emit({
      type: 'assistant',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: messageId,
        role: 'assistant',
        model,
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...calls.map((call, offset) => ({ type: 'tool_use', id: call.id, name: call.name, input: parsedInputs[offset]!.input })),
        ],
        stop_reason: null,
        usage: turnUsage,
      },
    });
    emit(streamEvent(sessionId, { type: 'message_delta', delta: { stop_reason: stopReason }, usage: turnUsage }));
    emit(streamEvent(sessionId, { type: 'message_stop' }));

    messages.push({
      role: 'assistant',
      content: text || null,
      ...(calls.length > 0
        ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments || '{}' } })) }
        : {}),
    });
    if (text) finalText = text;

    if (calls.length === 0) {
      emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        stop_reason: stopReason,
        session_id: sessionId,
        result: finalText,
        duration_ms: now() - startedAt,
        usage,
      });
      return;
    }

    const results = [];
    for (const [offset, call] of calls.entries()) {
      const parsed = parsedInputs[offset]!;
      const result = parsed.error
        ? { content: `Error: ${parsed.error}`, isError: true }
        : await executeHarnessTool(projectDir, call.name, parsed.input);
      results.push({ type: 'tool_result', tool_use_id: call.id, content: result.content, is_error: result.isError });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
    }
    emit({ type: 'user', session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: results } });
  }

  throw new DatabricksHarnessError(`Stopped after ${maxTurns} model turns without finishing.`);
}

function requestCompletion(
  fetchImpl: typeof fetch,
  host: string,
  token: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number | null,
): Promise<Response> {
  return fetchImpl(`${host}/serving-endpoints/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      messages,
      tools: HARNESS_TOOLS,
      stream: true,
      ...(maxTokens !== null ? { max_tokens: maxTokens } : {}),
    }),
  });
}

async function assertOk(response: Response, model: string): Promise<void> {
  if (response.ok) return;
  const detail = (await response.text().catch(() => '')).slice(0, 500);
  if (response.status === 401) {
    throw new DatabricksHarnessError(
      'Databricks rejected your session token while calling Model Serving. Reload OpenDesign and send the message again.',
    );
  }
  if (response.status === 403 || response.status === 404) {
    throw new DatabricksHarnessError(
      `You do not have access to the serving endpoint "${model}" (HTTP ${response.status}). Pick another model or ask a workspace admin for CAN QUERY. ${detail}`.trim(),
    );
  }
  if (response.status === 429) {
    throw new DatabricksHarnessError(`The serving endpoint "${model}" is rate limited (HTTP 429). Try again shortly. ${detail}`.trim());
  }
  throw new DatabricksHarnessError(`Model Serving returned HTTP ${response.status} for "${model}". ${detail}`.trim());
}

async function* sseJson(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      const parsed = parseSseLine(line);
      if (parsed === 'done') return;
      if (parsed) yield parsed;
    }
  }
  const parsed = parseSseLine(buffer.trim());
  if (parsed && parsed !== 'done') yield parsed;
}

function parseSseLine(line: string): Record<string, unknown> | 'done' | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice('data:'.length).trim();
  if (payload === '[DONE]') return 'done';
  try {
    const value: unknown = JSON.parse(payload);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Text from a delta `content`: a string, or (some endpoints) a list of typed parts. */
function deltaText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function parseArguments(raw: string): { input: Record<string, unknown>; error: string | null } {
  if (raw.trim() === '') return { input: {}, error: null };
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? { input: value, error: null } : { input: {}, error: 'tool arguments must be a JSON object' };
  } catch {
    return { input: {}, error: 'tool arguments were not valid JSON' };
  }
}

async function userContent(prompt: string, imagePaths: string[]): Promise<unknown> {
  if (imagePaths.length === 0) return prompt;
  const parts: unknown[] = [{ type: 'text', text: prompt }];
  for (const imagePath of imagePaths) {
    try {
      const bytes = await fs.readFile(imagePath);
      parts.push({ type: 'image_url', image_url: { url: `data:${imageMime(imagePath)};base64,${bytes.toString('base64')}` } });
    } catch {
      // An unreadable attachment should not sink the turn; the prompt text
      // still names it.
    }
  }
  return parts;
}

function imageMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function streamEvent(sessionId: string, event: Record<string, unknown>): HarnessFrame {
  return { type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
