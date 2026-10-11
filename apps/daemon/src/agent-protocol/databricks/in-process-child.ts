// A ChildProcess-shaped handle for the in-process Databricks agent.
//
// The chat-run orchestrator in `server.ts` owns a great deal of lifecycle
// around `run.child`: cancellation and watchdogs signal it, retries swap it,
// and the terminal decision (status, persistence, retry, artifacts) happens in
// its `close` handler. Rather than fork that machinery for a runtime that
// spawns nothing, the Databricks agent presents the same surface — `stdout` /
// `stderr` / `stdin` streams, `pid`, `exitCode` / `signalCode`, `kill()`, and
// `exit` / `close` events — and the harness runs behind it.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export interface InProcessAgentChild extends EventEmitter {
  readonly pid: undefined;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly stdin: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  /** Aborted when the orchestrator signals the "process". */
  readonly abortSignal: AbortSignal;
  kill(signal?: NodeJS.Signals | number): boolean;
  /** Called by the runtime when its work is done. Idempotent. */
  finish(code: number | null, signal?: NodeJS.Signals | null): void;
}

export function createInProcessAgentChild(): InProcessAgentChild {
  const emitter = new EventEmitter() as InProcessAgentChild;
  const controller = new AbortController();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let finished = false;

  Object.assign(emitter, {
    pid: undefined,
    stdout,
    stderr,
    stdin,
    exitCode: null,
    signalCode: null,
    killed: false,
    abortSignal: controller.signal,
  });

  emitter.finish = (code, signal = null) => {
    if (finished) return;
    finished = true;
    emitter.exitCode = signal ? null : code;
    emitter.signalCode = signal;
    stdout.end();
    stderr.end();
    stdin.end();
    // Match Node's ordering: `exit`, then `close` once stdio is drained. Defer
    // so listeners attached in the same tick as the start still observe it.
    setImmediate(() => {
      emitter.emit('exit', emitter.exitCode, signal);
      emitter.emit('close', emitter.exitCode, signal);
    });
  };

  emitter.kill = (signal: NodeJS.Signals | number = 'SIGTERM') => {
    if (finished) return false;
    emitter.killed = true;
    controller.abort();
    // The harness observes the abort and returns `canceled`; finish with the
    // signal so the orchestrator classifies it like a signalled child.
    emitter.finish(null, typeof signal === 'string' ? signal : 'SIGTERM');
    return true;
  };

  return emitter;
}
