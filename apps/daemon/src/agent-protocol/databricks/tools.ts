// Built-in tools for the in-process Databricks agent.
//
// Names and input shapes deliberately match Claude Code's (`Read`, `Write`,
// `Edit`, `LS`, `Bash` with `file_path` / `content` / `old_string` / …) so the
// existing chat UI, produced-file tracking, and tool-input path scanning treat
// these calls exactly like the ones the CLI runtimes emitted. Every tool runs
// through the `AgentExecutor`, never touching fs / child_process directly.
import type { ServingToolSpec } from '../../integrations/databricks-serving.js';
import type { AgentExecutor } from './executor.js';

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export interface AgentTool {
  spec: ServingToolSpec;
  run(input: Record<string, unknown>, context: { executor: AgentExecutor; signal?: AbortSignal }): Promise<ToolOutcome>;
}

const MAX_TOOL_RESULT_CHARS = 64_000;

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… [truncated ${text.length - MAX_TOOL_RESULT_CHARS} characters]`;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string`);
  return value;
}

function ok(content: string): ToolOutcome {
  return { content: truncate(content), isError: false };
}

const readTool: AgentTool = {
  spec: {
    type: 'function',
    function: {
      name: 'Read',
      description:
        'Read a UTF-8 text file. Paths are relative to the project directory (absolute paths inside it also work); ' +
        'nothing outside the project can be read.',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'File to read' } },
        required: ['file_path'],
      },
    },
  },
  async run(input, { executor }) {
    return ok(await executor.readFile(requireString(input, 'file_path')));
  },
};

const writeTool: AgentTool = {
  spec: {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Create or overwrite a file with the given content. Parent directories are created.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File to write' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  async run(input, { executor }) {
    const filePath = requireString(input, 'file_path');
    const content = requireString(input, 'content');
    await executor.writeFile(filePath, content);
    return ok(`Wrote ${content.split('\n').length} lines to ${filePath}`);
  },
};

const editTool: AgentTool = {
  spec: {
    type: 'function',
    function: {
      name: 'Edit',
      description:
        'Replace an exact string in a file. `old_string` must occur exactly once unless `replace_all` is true.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  async run(input, { executor }) {
    const filePath = requireString(input, 'file_path');
    const oldString = requireString(input, 'old_string');
    const newString = requireString(input, 'new_string');
    if (!oldString) return { content: '"old_string" must not be empty', isError: true };
    const current = await executor.readFile(filePath);
    const occurrences = current.split(oldString).length - 1;
    if (occurrences === 0) return { content: `old_string not found in ${filePath}`, isError: true };
    if (occurrences > 1 && input.replace_all !== true) {
      return {
        content: `old_string occurs ${occurrences} times in ${filePath}; pass replace_all or add context`,
        isError: true,
      };
    }
    const next = input.replace_all === true
      ? current.split(oldString).join(newString)
      : current.replace(oldString, () => newString);
    await executor.writeFile(filePath, next);
    return ok(`Edited ${filePath} (${input.replace_all === true ? occurrences : 1} replacement${occurrences > 1 && input.replace_all === true ? 's' : ''})`);
  },
};

const listTool: AgentTool = {
  spec: {
    type: 'function',
    function: {
      name: 'LS',
      description: 'List a directory. Defaults to the project directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory to list' } },
      },
    },
  },
  async run(input, { executor }) {
    const dir = typeof input.path === 'string' && input.path.trim() ? input.path : '.';
    const entries = await executor.listDir(dir);
    if (entries.length === 0) return ok('(empty)');
    return ok(entries.map((entry) => (entry.kind === 'directory' ? `${entry.name}/` : entry.name)).join('\n'));
  },
};

/** Returned for every `Bash` call when the executor has no isolated sandbox. */
export const CODE_EXECUTION_SANDBOX_REQUIRED_MESSAGE =
  'Code execution requires the Databricks sandbox (not yet enabled). ' +
  'Shell commands cannot run here; use Read, Write, Edit and LS to work with project files.';

const bashTool: AgentTool = {
  spec: {
    type: 'function',
    function: {
      name: 'Bash',
      description:
        'Run a shell command in the project directory and return its output. ' +
        'Only available when the Databricks sandbox is enabled; otherwise every call is refused.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (max 600000)' },
        },
        required: ['command'],
      },
    },
  },
  async run(input, { executor, signal }) {
    // Disabled unless the executor is an isolated sandbox: the local executor
    // deliberately has no `runCommand` (see executor.ts).
    if (!executor.runCommand) return { content: CODE_EXECUTION_SANDBOX_REQUIRED_MESSAGE, isError: true };
    const command = requireString(input, 'command');
    const result = await executor.runCommand(command, {
      ...(typeof input.timeout === 'number' ? { timeoutMs: input.timeout } : {}),
      ...(signal ? { signal } : {}),
    });
    const parts = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : '');
    const status = result.timedOut
      ? '\n[command timed out]'
      : result.exitCode && result.exitCode !== 0
        ? `\n[exit code ${result.exitCode}]`
        : '';
    return {
      content: truncate(`${parts}${status}` || '(no output)'),
      isError: result.timedOut || (result.exitCode ?? 0) !== 0 || result.signal !== null,
    };
  },
};

export const BUILTIN_AGENT_TOOLS: readonly AgentTool[] = [readTool, writeTool, editTool, listTool, bashTool];

export function toolSpecs(tools: readonly AgentTool[]): ServingToolSpec[] {
  return tools.map((tool) => tool.spec);
}
