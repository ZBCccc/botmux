/**
 * Daemon-backed `WorkerSpawnFn` implementation.
 *
 * Forks `worker.js` for a single workflow step, sends the prompt via
 * the `init` IPC, and resolves with the agent's final transcript when
 * the worker emits `final_output` and quiesces.
 *
 * Why not reuse `forkWorker` from `core/worker-pool.ts`: that path is
 * tightly coupled to chat / card / streaming state (DaemonSession,
 * dashboardEventBus, sessionStore writes).  Workflow steps don't have
 * a real chat to bind to — we mint a synthetic chatId / rootMessageId
 * and ignore the worker's chat-side side effects (streaming card POST,
 * screenshot uploads).  The bot's real `larkAppId / larkAppSecret`
 * still flow through so the CLI adapter's environment matches a real
 * spawn.
 *
 * The `WorkerProcessFactory` indirection keeps the module unit-testable:
 * tests inject a scripted process that emits canned IPC frames, real
 * code injects `forkWorkerJs` (defined below).
 */

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  DaemonRunOneShotInput,
  DaemonRunOneShotResult,
  DaemonSpawnDeps,
} from './spawn-bot.js';

// ─── IPC payloads (subset of WorkerToDaemon we care about) ────────────────

type WorkerEvent =
  | { type: 'ready'; port: number; token: string }
  | {
      type: 'final_output';
      content: string;
      lastUuid: string;
      turnId: string;
      kind?: 'bridge' | 'local-turn' | 'local-turn-headless';
      userText?: string;
    }
  | {
      type: 'screen_update';
      content: string;
      status: 'working' | 'idle' | 'analyzing';
    }
  | { type: 'prompt_ready' }
  | { type: 'claude_exit'; code: number | null; signal: string | null }
  | { type: 'error'; message: string };

// ─── Worker process abstraction (factory + handle) ────────────────────────

export interface WorkerHandle {
  send(msg: unknown): void;
  on(event: 'message', cb: (msg: WorkerEvent) => void): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
  readonly pid?: number;
}

export interface WorkerProcessFactory {
  spawn(opts: WorkerSpawnOptions): WorkerHandle;
}

export type WorkerSpawnOptions = {
  workerPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/** Default factory: real `node:child_process.fork` against `worker.js`. */
export const forkWorkerJsFactory: WorkerProcessFactory = {
  spawn(opts) {
    const child: ChildProcess = fork(opts.workerPath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: opts.cwd,
      env: opts.env,
    });
    return {
      send: (m) => child.send(m as never),
      on: (event: string, cb: (...args: unknown[]) => void) => {
        child.on(event as never, cb);
      },
      kill: (sig) => {
        if (!child.killed) child.kill(sig);
      },
      get pid() {
        return child.pid;
      },
    } as WorkerHandle;
  },
};

// ─── Deps for the factory ────────────────────────────────────────────────

export type WorkflowDaemonSpawnDeps = {
  /** Real workers need access to bot credentials per step. */
  resolveLarkCredentials(botName: string): {
    larkAppId: string;
    larkAppSecret: string;
  };
  /** Override worker.js path (tests).  Default: `<dist>/worker.js`. */
  workerPath?: string;
  /** Override process factory (tests). */
  factory?: WorkerProcessFactory;
  /**
   * Override how long we wait for the worker's first final_output after
   * init.  Defaults to 5 minutes — long enough for typical agent steps
   * with tool use.  Workflow `node.timeoutMs` overrides on a per-step
   * basis.
   */
  defaultTimeoutMs?: number;
  /**
   * After we receive `final_output` we wait `quiesceMs` before resolving,
   * in case the worker emits additional turns (multi-step agent loops).
   * Tests can shrink this.  Default 800 ms.
   */
  quiesceMs?: number;
};

export function createWorkflowDaemonSpawn(
  deps: WorkflowDaemonSpawnDeps,
): DaemonSpawnDeps {
  const factory = deps.factory ?? forkWorkerJsFactory;
  const workerPath = deps.workerPath ?? defaultWorkerPath();
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? 5 * 60 * 1000;
  const quiesceMs = deps.quiesceMs ?? 800;

  return {
    runOneShot: (input) =>
      runOneShotImpl(input, {
        factory,
        workerPath,
        defaultTimeoutMs,
        quiesceMs,
        resolveLarkCredentials: deps.resolveLarkCredentials,
      }),
  };
}

// ─── Default worker.js path ──────────────────────────────────────────────

function defaultWorkerPath(): string {
  // This module typically runs from `dist/workflows/daemon-spawn.js`;
  // worker.js lives next to dist root, i.e. `<dist>/worker.js`.
  // When running from source via ts-node etc., fall back to `src/worker.ts`
  // (the factory is meant for production; tests should override).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', 'worker.js');
  if (existsSync(candidate)) return candidate;
  return join(here, '..', '..', 'src', 'worker.ts');
}

// ─── runOneShot core ─────────────────────────────────────────────────────

type RunOneShotInternalDeps = {
  factory: WorkerProcessFactory;
  workerPath: string;
  defaultTimeoutMs: number;
  quiesceMs: number;
  resolveLarkCredentials: WorkflowDaemonSpawnDeps['resolveLarkCredentials'];
};

async function runOneShotImpl(
  input: DaemonRunOneShotInput,
  deps: RunOneShotInternalDeps,
): Promise<DaemonRunOneShotResult> {
  const creds = deps.resolveLarkCredentials(input.botName);
  const startedAt = Date.now();
  const synthetic = syntheticIds(input);

  const worker = deps.factory.spawn({
    workerPath: deps.workerPath,
    cwd: input.workingDir ?? process.cwd(),
    env: {
      ...process.env,
      // Marker so the CLI session / skill detect a workflow-issued worker.
      BOTMUX_WORKFLOW: '1',
      BOTMUX_WORKFLOW_RUN_ID: input.runId,
      BOTMUX_WORKFLOW_NODE_ID: input.nodeId,
    },
  });

  let webPort: number | undefined;
  const collectedOutputs: Array<{ content: string; turnId: string }> = [];
  let quiesceTimer: NodeJS.Timeout | undefined;
  const cliId = input.botSnapshot?.cliId ?? 'claude-code';

  const init = {
    type: 'init' as const,
    sessionId: synthetic.sessionId,
    chatId: synthetic.chatId,
    rootMessageId: synthetic.rootMessageId,
    workingDir: input.workingDir ?? process.cwd(),
    cliId,
    backendType: 'pty' as const,
    prompt: input.prompt,
    resume: false,
    larkAppId: creds.larkAppId,
    larkAppSecret: creds.larkAppSecret,
    botName: input.botName,
    locale: 'zh' as const,
  };

  return new Promise<DaemonRunOneShotResult>((resolve, reject) => {
    const timeoutMs = input.timeoutMs ?? deps.defaultTimeoutMs;
    const hardDeadline = setTimeout(() => {
      cleanup();
      reject(new Error(`workflow worker timeout after ${timeoutMs} ms`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(hardDeadline);
      if (quiesceTimer) clearTimeout(quiesceTimer);
      try {
        worker.send({ type: 'close' });
      } catch {
        /* worker may already be gone */
      }
      // Give close a moment to land before SIGTERM.
      setTimeout(() => worker.kill('SIGTERM'), 250);
    };

    const finish = (): void => {
      cleanup();
      const last = collectedOutputs[collectedOutputs.length - 1];
      if (!last) {
        reject(new Error('workflow worker quiesced without final_output'));
        return;
      }
      resolve({
        finalTranscript: last.content,
        session: {
          sessionId: synthetic.sessionId,
          larkAppId: creds.larkAppId,
          botName: input.botName,
          cliId,
          workingDir: input.workingDir,
          webPort,
          startedAt,
          endedAt: Date.now(),
        },
      });
    };

    const armQuiesce = (): void => {
      if (quiesceTimer) clearTimeout(quiesceTimer);
      quiesceTimer = setTimeout(finish, deps.quiesceMs);
    };

    worker.on('message', (event) => {
      switch (event.type) {
        case 'ready':
          webPort = event.port;
          worker.send(init);
          // Note: init may already have been sent by tests' scripted
          // factory before 'ready' lands.  Re-sending is a no-op
          // because `lastInitConfig` short-circuits.
          break;
        case 'final_output':
          collectedOutputs.push({
            content: event.content,
            turnId: event.turnId,
          });
          armQuiesce();
          break;
        case 'screen_update':
          if (event.status === 'idle' && collectedOutputs.length > 0) {
            armQuiesce();
          }
          break;
        case 'prompt_ready':
          if (collectedOutputs.length > 0) armQuiesce();
          break;
        case 'error':
          cleanup();
          reject(new Error(`worker error: ${event.message}`));
          break;
        case 'claude_exit':
          if (collectedOutputs.length > 0) {
            finish();
          } else {
            cleanup();
            reject(
              new Error(
                `CLI exited (code=${event.code ?? 'null'}, signal=${event.signal ?? 'null'}) before producing final_output`,
              ),
            );
          }
          break;
      }
    });

    worker.on('error', (err) => {
      cleanup();
      reject(err);
    });

    worker.on('exit', (code) => {
      // If we already resolved, the cleanup() already killed the worker;
      // ignore the exit.  If we're still waiting for output, treat as fail.
      if (collectedOutputs.length === 0) {
        clearTimeout(hardDeadline);
        if (quiesceTimer) clearTimeout(quiesceTimer);
        reject(
          new Error(
            `worker exited (code=${code ?? 'null'}) before producing final_output`,
          ),
        );
      }
    });

    // Some workers send 'init' eagerly without waiting for 'ready' — for
    // tests we send right away.  Real worker.js requires us to wait for
    // 'ready' (it allocates a port first), but it also short-circuits a
    // double `init`, so a redundant send is harmless.
    try {
      worker.send(init);
    } catch {
      /* worker may not be ready yet — wait for 'ready' to retry */
    }
  });
}

function syntheticIds(input: DaemonRunOneShotInput): {
  sessionId: string;
  chatId: string;
  rootMessageId: string;
} {
  return {
    sessionId: `wf-${input.runId}-${input.activityId}-${input.attemptId}`,
    chatId: `wf-chat-${input.runId}`,
    rootMessageId: `wf-root-${input.activityId}`,
  };
}
