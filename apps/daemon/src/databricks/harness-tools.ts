import { promises as fs } from 'node:fs';
import path from 'node:path';

// File tools for the Databricks agent harness. Names and input shapes follow
// Claude Code's (Write / Edit / Read / Glob / Grep / TodoWrite) because the
// design system prompt is written in that vocabulary and the web's execution
// record already knows how to render those calls.
//
// Every path is confined to the run's project directory: relative paths
// resolve against it, and an absolute path or a symlink that lands outside it
// is refused. There is deliberately no shell tool — the app container is
// shared by every signed-in user, so an agent gets file access to its own
// project and nothing else.

export interface HarnessToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface HarnessToolResult {
  content: string;
  isError: boolean;
}

const MAX_RESULT_CHARS = 20_000;
const MAX_READ_LINES = 2_000;
const MAX_LISTED_FILES = 500;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.od', '.next', 'dist']);

export const HARNESS_TOOLS: HarnessToolDefinition[] = [
  tool('Write', 'Create or overwrite a file in the project directory.', {
    file_path: { type: 'string', description: 'Absolute path inside the project directory, or a path relative to it.' },
    content: { type: 'string', description: 'The complete file content.' },
  }, ['file_path', 'content']),
  tool('Edit', 'Replace an exact string in an existing project file.', {
    file_path: { type: 'string' },
    old_string: { type: 'string', description: 'Exact text to replace; must be unique unless replace_all is true.' },
    new_string: { type: 'string' },
    replace_all: { type: 'boolean' },
  }, ['file_path', 'old_string', 'new_string']),
  tool('Read', 'Read a project file, returned with line numbers.', {
    file_path: { type: 'string' },
    offset: { type: 'number', description: '1-based line to start from.' },
    limit: { type: 'number', description: 'Maximum number of lines.' },
  }, ['file_path']),
  tool('Glob', 'List project files matching a glob pattern such as "**/*.html".', {
    pattern: { type: 'string' },
    path: { type: 'string', description: 'Directory to search, relative to the project directory.' },
  }, ['pattern']),
  tool('Grep', 'Search project files for a regular expression; returns matching lines.', {
    pattern: { type: 'string' },
    path: { type: 'string' },
    glob: { type: 'string', description: 'Only search files matching this glob.' },
  }, ['pattern']),
  tool('TodoWrite', 'Replace the task plan shown to the user.', {
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          activeForm: { type: 'string' },
        },
        required: ['content', 'status'],
      },
    },
  }, ['todos']),
];

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): HarnessToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

class ToolInputError extends Error {}

export async function executeHarnessTool(
  projectDir: string,
  name: string,
  input: Record<string, unknown>,
): Promise<HarnessToolResult> {
  try {
    const content = await runTool(projectDir, name, input);
    return { content: truncate(content), isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: `Error: ${message}`, isError: true };
  }
}

async function runTool(projectDir: string, name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'Write': {
      const target = await resolveInsideProject(projectDir, requiredString(input, 'file_path'));
      const content = requiredString(input, 'content', { allowEmpty: true });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      return `File written successfully at: ${target}`;
    }
    case 'Edit': {
      const target = await resolveInsideProject(projectDir, requiredString(input, 'file_path'));
      const oldString = requiredString(input, 'old_string', { allowEmpty: true });
      const newString = requiredString(input, 'new_string', { allowEmpty: true });
      if (oldString === '') throw new ToolInputError('old_string must not be empty');
      const original = await fs.readFile(target, 'utf8');
      const occurrences = original.split(oldString).length - 1;
      if (occurrences === 0) throw new ToolInputError(`old_string was not found in ${target}`);
      if (occurrences > 1 && input.replace_all !== true) {
        throw new ToolInputError(`old_string appears ${occurrences} times in ${target}; make it unique or set replace_all`);
      }
      await fs.writeFile(target, original.split(oldString).join(newString), 'utf8');
      return `The file ${target} has been updated.`;
    }
    case 'Read': {
      const target = await resolveInsideProject(projectDir, requiredString(input, 'file_path'));
      const buffer = await fs.readFile(target);
      if (buffer.includes(0)) return `${target} is a binary file (${buffer.length} bytes).`;
      const lines = buffer.toString('utf8').split('\n');
      const start = Math.max(1, Math.floor(numberOr(input.offset, 1)));
      const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(numberOr(input.limit, MAX_READ_LINES))));
      return lines
        .slice(start - 1, start - 1 + limit)
        .map((line, index) => `${String(start + index).padStart(6)}\t${line}`)
        .join('\n');
    }
    case 'Glob': {
      const base = await resolveInsideProject(projectDir, optionalString(input, 'path') ?? '.');
      const matcher = globToRegExp(requiredString(input, 'pattern'));
      const files = (await listFiles(base)).filter((file) => matcher.test(file));
      if (files.length === 0) return 'No files found';
      return files.map((file) => path.join(base, file)).join('\n');
    }
    case 'Grep': {
      const base = await resolveInsideProject(projectDir, optionalString(input, 'path') ?? '.');
      let pattern: RegExp;
      try {
        pattern = new RegExp(requiredString(input, 'pattern'));
      } catch (error) {
        throw new ToolInputError(`invalid regular expression: ${(error as Error).message}`);
      }
      const fileGlob = optionalString(input, 'glob');
      const fileMatcher = fileGlob ? globToRegExp(fileGlob) : null;
      const matches: string[] = [];
      for (const file of await listFiles(base)) {
        if (fileMatcher && !fileMatcher.test(file) && !fileMatcher.test(path.basename(file))) continue;
        const buffer = await fs.readFile(path.join(base, file));
        if (buffer.includes(0)) continue;
        buffer.toString('utf8').split('\n').forEach((line, index) => {
          if (pattern.test(line)) matches.push(`${path.join(base, file)}:${index + 1}:${line}`);
        });
        if (matches.length >= MAX_LISTED_FILES) break;
      }
      return matches.length === 0 ? 'No matches found' : matches.slice(0, MAX_LISTED_FILES).join('\n');
    }
    case 'TodoWrite': {
      if (!Array.isArray(input.todos)) throw new ToolInputError('todos must be an array');
      return 'Todos have been modified successfully.';
    }
    default:
      throw new ToolInputError(`unknown tool: ${name}`);
  }
}

/**
 * Resolve `requested` against the project directory and refuse anything that
 * escapes it, including through a symlinked ancestor.
 */
export async function resolveInsideProject(projectDir: string, requested: string): Promise<string> {
  const root = await fs.realpath(projectDir);
  let target = path.resolve(root, requested);
  // The prompt may name the project by its unresolved path (e.g. macOS
  // /var → /private/var); an absolute path under that spelling is still inside.
  const fromLexicalRoot = path.relative(path.resolve(projectDir), path.resolve(requested));
  if (path.isAbsolute(requested) && !fromLexicalRoot.startsWith('..') && !path.isAbsolute(fromLexicalRoot)) {
    target = path.join(root, fromLexicalRoot);
  }
  const lexical = path.relative(root, target);
  if (lexical.startsWith('..') || path.isAbsolute(lexical)) {
    throw new ToolInputError(`${requested} is outside the project directory`);
  }
  let existing = target;
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      const relative = path.relative(root, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new ToolInputError(`${requested} resolves outside the project directory`);
      }
      return target;
    } catch (error) {
      if (error instanceof ToolInputError) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      existing = parent;
    }
  }
}

async function listFiles(base: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_LISTED_FILES) return;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        out.push(relative);
      }
    }
  }
  await walk(base, '');
  return out.sort();
}

export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') {
      source += glob[index + 2] === '/' ? '(?:.*/)?' : '.*';
      index += glob[index + 2] === '/' ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`^${source}$`);
}

function requiredString(input: Record<string, unknown>, key: string, { allowEmpty = false } = {}): string {
  const value = input[key];
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new ToolInputError(`${key} must be a ${allowEmpty ? '' : 'non-empty '}string`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function truncate(text: string): string {
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated)`;
}
