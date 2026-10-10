// In-process agent loop against Databricks Model Serving.
//
// Replaces the spawned agent CLIs: the daemon itself sends the conversation
// plus tool specs to a serving endpoint, streams the assistant reply, executes
// any tool calls through the `AgentExecutor`, feeds the results back, and
// repeats until the model answers without calling a tool.
//
// Output is the daemon's common agent-event vocabulary (`DaemonAgentPayload`
// plus the internal `error` event), delivered through `emit` — the same
// contract every CLI stream parser and the ACP / pi-rpc bridges satisfy, so
// the chat UI and message persistence need no Databricks-specific code.
import type { DaemonAgentPayload } from '@open-design/contracts';
import {
  DatabricksServingError,
  type DatabricksServingClient,
  type ServingMessage,
  type ServingToolCall,
  type ServingUsage,
} from '../../integrations/databricks-serving.js';
import type { AgentExecutor } from './executor.js';
import { toolSpecs, type AgentTool } from './tools.js';

export type DatabricksHarnessEvent =
  | DaemonAgentPayload
  | { type: 'error'; message: string; code?: string };

export interface DatabricksAgentRunOptions {
  client: DatabricksServingClient;
  endpoint: string;
  systemPrompt?: string;
  prompt: string;
  tools: readonly AgentTool[];
  executor: AgentExecutor;
  emit: (event: DatabricksHarnessEvent) => void;
  signal?: AbortSignal;
  /** Model round-trips before the loop gives up. */
  maxTurns?: number;
  maxTokens?: number;
  now?: () => number;
}

export interface DatabricksAgentRunResult {
  status: 'succeeded' | 'failed' | 'canceled';
  turns: number;
  usage: ServingUsage;
  error?: { code: string; message: string };
}

export const DEFAULT_MAX_AGENT_TURNS = 50;

export const DATABRICKS_AGENT_SYSTEM_PROMPT = [
  'You are the OpenDesign agent, running inside the OpenDesign daemon on Databricks.',
  'You work in the current project directory and can call tools to inspect and change it:',
  'Read, Write, Edit, LS (files, paths relative to the project directory) and Bash (shell commands in the project directory).',
  'Prefer writing deliverables to files with Write/Edit rather than pasting large files into the reply.',
  'When the task is finished, reply with a short summary and do not call any more tools.',
].join('\n');

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
  announced: boolean;
}

function addUsage(total: ServingUsage, next: ServingUsage): ServingUsage {
  return {
    input_tokens: (total.input_tokens ?? 0) + (next.input_tokens ?? 0),
    output_tokens: (total.output_tokens ?? 0) + (next.output_tokens ?? 0),
  };
}

function parseToolInput(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value };
    return { ok: false, message: 'Tool arguments must be a JSON object' };
  } catch {
    return { ok: false, message: 'Tool arguments were not valid JSON' };
  }
}

export async function runDatabricksAgent(options: DatabricksAgentRunOptions): Promise<DatabricksAgentRunResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_AGENT_TURNS;
  const toolsByName = new Map(options.tools.map((tool) => [tool.spec.function.name, tool]));
  const specs = toolSpecs(options.tools);
  const messages: ServingMessage[] = [
    { role: 'system', content: options.systemPrompt ?? DATABRICKS_AGENT_SYSTEM_PROMPT },
    { role: 'user', content: options.prompt },
  ];
  let usage: ServingUsage = {};
  let turns = 0;
  let stopReason: string | null = null;

  const emitUsage = () => {
    options.emit({
      type: 'usage',
      usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 },
      durationMs: now() - startedAt,
      stopReason,
    });
  };
  const canceled = (): DatabricksAgentRunResult => ({ status: 'canceled', turns, usage });

  options.emit({ type: 'status', label: 'requesting', model: options.endpoint });

  try {
    while (turns < maxTurns) {
      if (options.signal?.aborted) return canceled();
      turns += 1;
      let text = '';
      let thinkingStarted = false;
      let finishReason: string | null = null;
      const calls = new Map<number, PendingToolCall>();

      const stream = options.client.streamChat({
        endpoint: options.endpoint,
        messages,
        tools: specs,
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      for await (const event of stream) {
        if (options.signal?.aborted) return canceled();
        switch (event.type) {
          case 'text':
            text += event.delta;
            options.emit({ type: 'text_delta', delta: event.delta });
            break;
          case 'thinking':
            if (!thinkingStarted) {
              thinkingStarted = true;
              options.emit({ type: 'thinking_start' });
            }
            options.emit({ type: 'thinking_delta', delta: event.delta });
            break;
          case 'tool_call_delta': {
            let call = calls.get(event.index);
            if (!call) {
              call = { id: '', name: '', arguments: '', announced: false };
              calls.set(event.index, call);
            }
            if (event.id && !call.id) call.id = event.id;
            if (event.name && !call.name) call.name = event.name;
            call.arguments += event.argumentsDelta;
            if (!call.id) call.id = `call_${turns}_${event.index}`;
            if (call.name && !call.announced) {
              call.announced = true;
              options.emit({ type: 'tool_in_flight', id: call.id, name: call.name, input: {}, startedAt: now() });
            }
            if (call.name && event.argumentsDelta) {
              // Liveness heartbeat while a large argument (e.g. a Write's
              // content) streams; the web client never renders it.
              options.emit({ type: 'tool_input_delta', id: call.id, name: call.name, delta: event.argumentsDelta });
            }
            break;
          }
          case 'usage':
            usage = addUsage(usage, event.usage);
            break;
          case 'finish':
            finishReason = event.reason;
            break;
        }
      }

      const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
      if (ordered.length === 0) {
        stopReason = finishReason === 'length' ? 'max_tokens' : 'end_turn';
        emitUsage();
        return { status: 'succeeded', turns, usage };
      }

      const toolCalls: ServingToolCall[] = ordered.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
      }));
      messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });

      for (const call of ordered) {
        if (options.signal?.aborted) return canceled();
        const parsed = parseToolInput(call.arguments);
        const input = parsed.ok ? parsed.value : { raw: call.arguments };
        options.emit({ type: 'tool_use', id: call.id, name: call.name, input });
        let content: string;
        let isError: boolean;
        const tool = toolsByName.get(call.name);
        if (!parsed.ok) {
          content = parsed.message;
          isError = true;
        } else if (!tool) {
          content = `Unknown tool "${call.name}". Available tools: ${[...toolsByName.keys()].join(', ')}`;
          isError = true;
        } else {
          try {
            const outcome = await tool.run(parsed.value, {
              executor: options.executor,
              ...(options.signal ? { signal: options.signal } : {}),
            });
            content = outcome.content;
            isError = outcome.isError;
          } catch (err) {
            content = (err as Error)?.message ?? String(err);
            isError = true;
          }
        }
        options.emit({ type: 'tool_result', toolUseId: call.id, content, isError, completedAt: now() });
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    stopReason = 'max_turns';
    emitUsage();
    const message = `Stopped after ${maxTurns} model turns without a final answer`;
    options.emit({ type: 'error', message, code: 'DATABRICKS_MAX_TURNS' });
    return { status: 'failed', turns, usage, error: { code: 'DATABRICKS_MAX_TURNS', message } };
  } catch (err) {
    if (options.signal?.aborted) return canceled();
    const code = err instanceof DatabricksServingError ? err.code : 'DATABRICKS_AGENT_FAILED';
    const message = (err as Error)?.message ?? String(err);
    stopReason = 'error';
    emitUsage();
    options.emit({ type: 'error', message, code });
    return { status: 'failed', turns, usage, error: { code, message } };
  }
}
