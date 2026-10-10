import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENT_TOOLS,
  CODE_EXECUTION_SANDBOX_REQUIRED_MESSAGE,
  createLocalExecutor,
  createRunExecutor,
  type AgentExecutor,
} from '../src/agent-protocol/databricks/index.js';

function tool(name: string) {
  const found = BUILTIN_AGENT_TOOLS.find((candidate) => candidate.spec.function.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

async function call(executor: AgentExecutor, name: string, input: Record<string, unknown>) {
  try {
    return await tool(name).run(input, { executor });
  } catch (err) {
    // The harness turns a thrown tool error into an isError tool_result.
    return { content: (err as Error).message, isError: true };
  }
}

describe('Databricks local executor containment', () => {
  let base: string;
  let project: string;
  let outside: string;
  let executor: AgentExecutor;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'od-dbx-contain-'));
    project = path.join(base, 'project');
    outside = path.join(base, 'outside');
    mkdirSync(project);
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    writeFileSync(path.join(project, 'inside.txt'), 'hello');
    executor = createRunExecutor({ cwd: project });
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('reads, writes, edits and lists inside the project', async () => {
    expect(await call(executor, 'Read', { file_path: 'inside.txt' })).toEqual({ content: 'hello', isError: false });
    expect(await call(executor, 'Read', { file_path: path.join(project, 'inside.txt') })).toMatchObject({ isError: false });
    expect(await call(executor, 'Write', { file_path: 'nested/dir/a.txt', content: 'x' })).toMatchObject({ isError: false });
    expect(readFileSync(path.join(project, 'nested/dir/a.txt'), 'utf8')).toBe('x');
    expect(await call(executor, 'Edit', { file_path: 'inside.txt', old_string: 'hello', new_string: 'bye' })).toMatchObject({ isError: false });
    expect(readFileSync(path.join(project, 'inside.txt'), 'utf8')).toBe('bye');
    expect(await call(executor, 'LS', {})).toEqual({ content: 'inside.txt\nnested/', isError: false });
  });

  it('follows a symlink that stays inside the project', async () => {
    symlinkSync(path.join(project, 'inside.txt'), path.join(project, 'alias.txt'));
    expect(await call(executor, 'Read', { file_path: 'alias.txt' })).toEqual({ content: 'hello', isError: false });
  });

  it.each([
    ['a .. traversal', () => '../outside/secret.txt'],
    ['an absolute path outside the project', () => path.join(outside, 'secret.txt')],
    ['a system file', () => '/etc/passwd'],
    ['/proc', () => '/proc/self/environ'],
  ])('refuses to Read %s', async (_label, target) => {
    const outcome = await call(executor, 'Read', { file_path: target() });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('outside the project directory');
  });

  it('refuses to LS outside the project (absolute or traversal)', async () => {
    for (const dir of [outside, '..', '/']) {
      const outcome = await call(executor, 'LS', { path: dir });
      expect(outcome).toMatchObject({ isError: true, content: expect.stringContaining('outside the project directory') });
    }
  });

  it('refuses to Write or Edit outside the project', async () => {
    for (const file_path of ['../outside/new.txt', path.join(outside, 'new.txt')]) {
      expect(await call(executor, 'Write', { file_path, content: 'pwned' })).toMatchObject({ isError: true });
    }
    expect(existsSync(path.join(outside, 'new.txt'))).toBe(false);
    expect(
      await call(executor, 'Edit', { file_path: '../outside/secret.txt', old_string: 'top', new_string: 'x' }),
    ).toMatchObject({ isError: true });
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('refuses symlink escapes for read, list and write', async () => {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(project, 'leak.txt'));
    symlinkSync(outside, path.join(project, 'leakdir'));
    expect(await call(executor, 'Read', { file_path: 'leak.txt' })).toMatchObject({ isError: true });
    expect(await call(executor, 'Read', { file_path: 'leakdir/secret.txt' })).toMatchObject({ isError: true });
    expect(await call(executor, 'LS', { path: 'leakdir' })).toMatchObject({ isError: true });
    expect(await call(executor, 'Write', { file_path: 'leak.txt', content: 'pwned' })).toMatchObject({ isError: true });
    expect(await call(executor, 'Write', { file_path: 'leakdir/new.txt', content: 'pwned' })).toMatchObject({ isError: true });
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    expect(existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });

  it('refuses a dangling symlink at the leaf instead of creating its target', async () => {
    symlinkSync(path.join(outside, 'created.txt'), path.join(project, 'dangling.txt'));
    expect(await call(executor, 'Write', { file_path: 'dangling.txt', content: 'pwned' })).toMatchObject({ isError: true });
    expect(existsSync(path.join(outside, 'created.txt'))).toBe(false);
  });
});

describe('Databricks Bash tool without the sandbox', () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(path.join(tmpdir(), 'od-dbx-bash-'));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('the run executor has no local command execution', () => {
    expect(createRunExecutor({ cwd: project }).runCommand).toBeUndefined();
    expect(createLocalExecutor({ cwd: project }).runCommand).toBeUndefined();
  });

  it('refuses every command with the sandbox-required message and runs nothing', async () => {
    const marker = path.join(project, 'ran.txt');
    const outcome = await call(createRunExecutor({ cwd: project }), 'Bash', {
      command: `touch ${JSON.stringify(marker)}; curl https://example.com; cat /proc/self/environ`,
    });
    expect(outcome).toEqual({ content: CODE_EXECUTION_SANDBOX_REQUIRED_MESSAGE, isError: true });
    expect(outcome.content).toContain('Code execution requires the Databricks sandbox (not yet enabled)');
    expect(existsSync(marker)).toBe(false);
  });

  it('delegates to an executor that provides runCommand (the future sandbox seam)', async () => {
    const commands: string[] = [];
    const sandbox: AgentExecutor = {
      ...createLocalExecutor({ cwd: project }),
      kind: 'sandbox',
      async runCommand(command) {
        commands.push(command);
        return { exitCode: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false };
      },
    };
    expect(await call(sandbox, 'Bash', { command: 'echo ok' })).toEqual({ content: 'ok', isError: false });
    expect(commands).toEqual(['echo ok']);
  });
});
