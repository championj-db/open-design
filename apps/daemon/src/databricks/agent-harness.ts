// Entry point of the `databricks` agent runtime (runtimes/defs/databricks.ts).
// The daemon spawns it per run with the composed prompt on stdin, the project
// directory as cwd, and the signed-in user's workspace host and on-behalf-of
// token in DATABRICKS_HOST / DATABRICKS_TOKEN. Output is Claude Code
// stream-json on stdout; see harness-loop.ts.

import { databricksWorkspaceHost } from './auth-mode.js';
import { runDatabricksHarness, type HarnessFrame } from './harness-loop.js';
import { resolveDatabricksChatModel } from './serving-endpoints.js';

export interface HarnessArgs {
  model: string | null;
  imagePaths: string[];
}

export function parseHarnessArgs(argv: string[]): HarnessArgs {
  const args: HarnessArgs = { model: null, imagePaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--model' && value !== undefined) {
      args.model = value;
      index += 1;
    } else if (flag === '--image' && value !== undefined) {
      args.imagePaths.push(value);
      index += 1;
    }
  }
  return args;
}

function emit(frame: HarnessFrame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function emitFailure(message: string): void {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [message] });
  process.exitCode = 1;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const args = parseHarnessArgs(process.argv.slice(2));
  let host: string | null;
  try {
    host = databricksWorkspaceHost(process.env);
  } catch (error) {
    return emitFailure(error instanceof Error ? error.message : String(error));
  }
  const token = (process.env.DATABRICKS_TOKEN ?? '').trim();
  if (!host || token === '') {
    return emitFailure(
      'No Databricks user session reached this run. Reload OpenDesign and send the message again.',
    );
  }
  const prompt = await readStdin();
  try {
    await runDatabricksHarness({
      host,
      token,
      model: resolveDatabricksChatModel(args.model),
      projectDir: process.cwd(),
      prompt,
      imagePaths: args.imagePaths,
      emit,
    });
  } catch (error) {
    emitFailure(error instanceof Error ? error.message : String(error));
  }
}

await main();
