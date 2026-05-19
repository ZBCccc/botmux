import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  createWorkflowDaemonSpawn,
  type WorkerHandle,
  type WorkerProcessFactory,
} from '../src/workflows/daemon-spawn.js';
import {
  WORKFLOW_OUTPUT_BEGIN,
  WORKFLOW_OUTPUT_END,
} from '../src/workflows/spawn-bot.js';

// ─── scripted worker process ──────────────────────────────────────────────

type Script = (handle: ScriptHandle) => void;

interface ScriptHandle {
  emit(msg: unknown): void;
  emitExit(code: number | null): void;
  onSend(cb: (msg: unknown) => void): void;
}

function scriptedFactory(script: Script): WorkerProcessFactory {
  return {
    spawn(_opts) {
      const bus = new EventEmitter();
      const sendListeners: Array<(msg: unknown) => void> = [];
      const handle: WorkerHandle = {
        send: (msg) => {
          for (const cb of sendListeners) cb(msg);
        },
        on: (event, cb) => bus.on(event, cb as never),
        kill: () => {
          /* no-op for tests */
        },
        pid: 1234,
      };
      const scriptHandle: ScriptHandle = {
        emit: (msg) => bus.emit('message', msg),
        emitExit: (code) => bus.emit('exit', code),
        onSend: (cb) => sendListeners.push(cb),
      };
      // Run script async so the caller can hook .on('message') first.
      setImmediate(() => script(scriptHandle));
      return handle;
    },
  };
}

const baseInput = {
  botName: 'claude-loopy',
  botSnapshot: { larkAppId: 'cli_x', cliId: 'claude-code', displayName: 'Claude' },
  prompt: 'do thing',
  runId: 'run-x',
  nodeId: 'n',
  activityId: 'act',
  attemptId: 'att',
  workingDir: '/tmp',
};

const fakeCreds = { larkAppId: 'cli_x', larkAppSecret: 'secret' };

// ─── tests ────────────────────────────────────────────────────────────────

describe('createWorkflowDaemonSpawn', () => {
  it('happy path: resolves with last final_output content when worker quiesces', async () => {
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      quiesceMs: 30,
      factory: scriptedFactory((s) => {
        s.emit({ type: 'ready', port: 7878, token: 'tok' });
        s.emit({
          type: 'final_output',
          content: `${WORKFLOW_OUTPUT_BEGIN}{"answer":"hi"}${WORKFLOW_OUTPUT_END}`,
          lastUuid: 'u1',
          turnId: 't1',
        });
        s.emit({ type: 'screen_update', content: '', status: 'idle' });
      }),
    });
    const result = await deps.runOneShot(baseInput);
    expect(result.finalTranscript).toContain(WORKFLOW_OUTPUT_BEGIN);
    expect(result.session.larkAppId).toBe('cli_x');
    expect(result.session.cliId).toBe('claude-code');
    expect(result.session.botName).toBe('claude-loopy');
    expect(result.session.webPort).toBe(7878);
  });

  it('uses last final_output when multiple turns arrive (multi-step agent)', async () => {
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      quiesceMs: 30,
      factory: scriptedFactory((s) => {
        s.emit({ type: 'ready', port: 1, token: 't' });
        s.emit({
          type: 'final_output',
          content: 'draft v1',
          lastUuid: 'a',
          turnId: 't1',
        });
        s.emit({
          type: 'final_output',
          content: `revised\n${WORKFLOW_OUTPUT_BEGIN}{"v":2}${WORKFLOW_OUTPUT_END}`,
          lastUuid: 'b',
          turnId: 't2',
        });
        s.emit({ type: 'prompt_ready' });
      }),
    });
    const result = await deps.runOneShot(baseInput);
    expect(result.finalTranscript).toContain('"v":2');
    expect(result.finalTranscript).not.toContain('draft v1');
  });

  it('rejects when CLI exits without final_output', async () => {
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      quiesceMs: 30,
      factory: scriptedFactory((s) => {
        s.emit({ type: 'ready', port: 1, token: 't' });
        s.emit({ type: 'claude_exit', code: 1, signal: null });
      }),
    });
    await expect(deps.runOneShot(baseInput)).rejects.toThrow(/before producing final_output/);
  });

  it('rejects on worker error event', async () => {
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      factory: scriptedFactory((s) => {
        s.emit({ type: 'ready', port: 1, token: 't' });
        s.emit({ type: 'error', message: 'cli adapter missing' });
      }),
    });
    await expect(deps.runOneShot(baseInput)).rejects.toThrow(/cli adapter missing/);
  });

  it('honors per-step timeout when worker hangs', async () => {
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      factory: scriptedFactory((s) => {
        // Worker becomes ready but never emits final_output.
        s.emit({ type: 'ready', port: 1, token: 't' });
      }),
    });
    await expect(
      deps.runOneShot({ ...baseInput, timeoutMs: 80 }),
    ).rejects.toThrow(/timeout after 80/);
  });

  it('sends init message with synthetic chatId / rootMessageId and prompt', async () => {
    const sent: unknown[] = [];
    const factory = scriptedFactory((s) => {
      s.onSend((msg) => sent.push(msg));
      s.emit({ type: 'ready', port: 1, token: 't' });
      s.emit({
        type: 'final_output',
        content: `${WORKFLOW_OUTPUT_BEGIN}{}${WORKFLOW_OUTPUT_END}`,
        lastUuid: 'u',
        turnId: 't1',
      });
      s.emit({ type: 'screen_update', content: '', status: 'idle' });
    });
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      quiesceMs: 30,
      factory,
    });
    await deps.runOneShot(baseInput);
    const init = sent.find(
      (m): m is Record<string, unknown> =>
        typeof m === 'object' && m !== null && (m as Record<string, unknown>).type === 'init',
    );
    expect(init).toBeDefined();
    expect(init!.prompt).toBe('do thing');
    expect(init!.cliId).toBe('claude-code');
    expect(init!.larkAppId).toBe('cli_x');
    expect(init!.larkAppSecret).toBe('secret');
    expect(init!.sessionId).toContain('run-x');
    expect(init!.chatId).toContain('wf-chat');
  });

  it('credential resolver gets the bot name from input', async () => {
    const resolver = vi.fn(() => fakeCreds);
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: resolver,
      quiesceMs: 30,
      factory: scriptedFactory((s) => {
        s.emit({ type: 'ready', port: 1, token: 't' });
        s.emit({
          type: 'final_output',
          content: 'x',
          lastUuid: 'u',
          turnId: 't',
        });
        s.emit({ type: 'screen_update', content: '', status: 'idle' });
      }),
    });
    await deps.runOneShot({ ...baseInput, botName: 'codex-loopy' });
    expect(resolver).toHaveBeenCalledWith('codex-loopy');
  });
});
