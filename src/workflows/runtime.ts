/**
 * Workflow runtime — event-writing glue for orchestrator actions.
 *
 * `decideNextActions` in `orchestrator.ts` is pure; this module performs
 * the actual side effects: writes events to the EventLog and (for
 * subagent dispatch) invokes the worker spawn callback.
 *
 * The `WorkerSpawnFn` indirection keeps tests isolated from the real
 * worker / bot-registry / daemon plumbing — Slice D wires the live
 * spawn function; tests pass a fake.
 *
 * Scope (Slice B-1):
 *   - dispatchGate  → writes attemptCreated(gate) + waitCreated
 *   - dispatchWork  → writes attemptCreated(work) + invokes spawn
 *   - completeNode* / completeRun* → terminal node/run writes
 *     (rootCauseEventId resolved from the latest activityFailed event)
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { writeEffectInputSidecar } from './effect-input.js';
import { writeJsonBlob } from './blob.js';
import type { WorkflowDefinition } from './definition.js';
import type { EventLog } from './events/append.js';
import type { BotSnapshot, ErrorClass, ErrorCode, OutputRef } from './events/payloads.js';
import { replay, type Snapshot } from './events/replay.js';
import type {
  ActivityFailedEvent,
  AttemptCreatedEvent,
  NodeFailedEvent,
  NodeSucceededEvent,
  RunCanceledEvent,
  RunFailedEvent,
  RunSucceededEvent,
  WaitCreatedEvent,
} from './events/types.js';
import type {
  CompleteNodeFailedAction,
  CompleteNodeSucceededAction,
  CompleteRunFailedAction,
  CompleteRunSucceededAction,
  DispatchGateAction,
  DispatchWorkAction,
} from './orchestrator.js';
import { createWait } from './wait.js';
import { executeSideEffect } from './hostExecutors/protocol.js';
import type { HostExecutorRegistry, RegisteredHostExecutor } from './hostExecutors/registry.js';
import type { HostExecutorContext } from './hostExecutors/types.js';

// ─── Worker spawn contract ────────────────────────────────────────────────

export type WorkerSpawnInput = {
  botName: string;
  /** Snapshot captured at runCreated time — caller may override workingDir etc. */
  botSnapshot?: BotSnapshot;
  prompt: string;
  workingDir?: string;
  modelOverrides?: { model?: string; reasoningEffort?: string };
  toolPolicy?: { allow?: string[]; deny?: string[] };
  /** Activity context — useful for the spawner to namespace logs / ports. */
  activityId: string;
  attemptId: string;
  nodeId: string;
  runId: string;
};

export type WorkerSessionInfo = {
  sessionId: string;
  larkAppId?: string;
  botName: string;
  cliId?: string;
  workingDir?: string;
  webPort?: number;
  logPath?: string;
  startedAt: number;
  endedAt?: number;
};

export type WorkerSpawnResult =
  | {
      kind: 'success';
      /** Caller's worker produced this as the final structured output. */
      output: unknown;
      session: WorkerSessionInfo;
    }
  | {
      kind: 'failure';
      errorCode:
        | 'NetworkError'
        | 'WorkerCrashed'
        | 'OutputSchemaViolation'
        | 'InputValidationFailed'
        | 'UnknownProviderError';
      errorClass: ErrorClass;
      errorMessage: string;
      session?: WorkerSessionInfo;
    };

export type WorkerSpawnFn = (input: WorkerSpawnInput) => Promise<WorkerSpawnResult>;

// ─── Runtime context ──────────────────────────────────────────────────────

export type WorkflowRuntimeContext = {
  log: EventLog;
  def: WorkflowDefinition;
  spawnSubagent: WorkerSpawnFn;
  hostExecutors?: HostExecutorRegistry;
  /** Wall-clock source — injectable for deterministic tests. */
  now?: () => number;
};

function nowMs(ctx: WorkflowRuntimeContext): number {
  return ctx.now ? ctx.now() : Date.now();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function gateAttemptId(activityId: string): string {
  return `${activityId}::att-1`;
}

function workAttemptId(activityId: string, attemptNumber: number): string {
  return `${activityId}::att-${attemptNumber}`;
}

/**
 * Resolve the bot identity snapshot captured at runCreated.
 *
 * If caller supplies a Snapshot we read it directly (cheapest).
 * Otherwise we replay the log — slower but always available.  The
 * runtime always passes a snapshot in practice; the fallback exists so
 * tests that don't bother to compute one still get correct behavior.
 */
async function resolveBotSnapshot(
  ctx: WorkflowRuntimeContext,
  botName: string,
  snapshot?: Snapshot,
): Promise<BotSnapshot | undefined> {
  if (snapshot) return snapshot.run.botSnapshots?.[botName];
  const events = await ctx.log.readAll();
  if (events.length === 0) return undefined;
  const first = events[0]!;
  if (first.type !== 'runCreated') return undefined;
  const p = (first as { payload: unknown }).payload;
  if (typeof p !== 'object' || p === null || 'ref' in (p as Record<string, unknown>)) {
    return undefined;
  }
  const snaps = (p as { botSnapshots?: Record<string, BotSnapshot> }).botSnapshots;
  return snaps?.[botName];
}

async function attemptSidecarDir(
  log: EventLog,
  activityId: string,
  attemptId: string,
): Promise<string> {
  const dir = join(log.runDir, 'attempts', activityId, attemptId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeSessionSidecar(
  log: EventLog,
  activityId: string,
  attemptId: string,
  session: WorkerSessionInfo,
): Promise<void> {
  const dir = await attemptSidecarDir(log, activityId, attemptId);
  const file = join(dir, 'session.json');
  await fs.writeFile(file, JSON.stringify(session, null, 2), 'utf-8');
}

async function resolveWorkflowIdentity(
  ctx: WorkflowRuntimeContext,
  snapshot?: Snapshot,
): Promise<{ workflowId: string; revisionId: string }> {
  const snap = snapshot ?? replay(await ctx.log.readAll());
  if (!snap.run.workflowId || !snap.run.revisionId) {
    throw new Error(`workflow identity missing for run ${ctx.log.runId}`);
  }
  return { workflowId: snap.run.workflowId, revisionId: snap.run.revisionId };
}

async function failHostExecutor(
  ctx: WorkflowRuntimeContext,
  activityId: string,
  attemptId: string,
  error: { errorCode: ErrorCode; errorClass: ErrorClass; errorMessage: string },
): Promise<Extract<DispatchWorkResult, { kind: 'failed' }>> {
  await ctx.log.append({
    runId: ctx.log.runId,
    type: 'activityFailed',
    actor: 'scheduler',
    payload: {
      activityId,
      attemptId,
      error,
    },
  });
  return {
    kind: 'failed',
    attemptId,
    errorClass: error.errorClass,
    errorCode: error.errorCode,
    errorMessage: error.errorMessage,
  };
}

function executeRegisteredHostExecutor<I, O>(
  registered: RegisteredHostExecutor<I, O>,
  hostCtx: HostExecutorContext,
  input: unknown,
) {
  return executeSideEffect(hostCtx, input as I, registered.executor);
}

// ─── dispatchGate ─────────────────────────────────────────────────────────

/**
 * Open a humanGate.stage='before' wait.  Writes:
 *   1. `attemptCreated{nodeId, activityId=gate, attemptId, attemptNumber=1}`
 *   2. `waitCreated{waitKind='human-gate', deadlineAt?, prompt, onTimeout}`
 *
 * The caller (Slice C / Slice D) is responsible for actually rendering
 * the approval card to the IM channel after this returns.
 */
export async function dispatchGate(
  ctx: WorkflowRuntimeContext,
  action: DispatchGateAction,
): Promise<{
  attemptId: string;
  attemptCreated: AttemptCreatedEvent;
  waitCreated: WaitCreatedEvent;
}> {
  const attemptId = gateAttemptId(action.activityId);
  const inputRef = await writeJsonBlob(ctx.log, {
    kind: 'human-gate',
    prompt: action.humanGate.prompt,
    approvers: action.humanGate.approvers,
  });

  const attemptCreated = (await ctx.log.append({
    runId: ctx.log.runId,
    type: 'attemptCreated',
    actor: 'scheduler',
    payload: {
      nodeId: action.nodeId,
      activityId: action.activityId,
      attemptId,
      attemptNumber: 1,
      inputRef,
    },
  })) as AttemptCreatedEvent;

  const deadlineAt = action.humanGate.deadlineMs
    ? nowMs(ctx) + action.humanGate.deadlineMs
    : undefined;

  const waitCreated = await createWait(ctx.log, {
    activityId: action.activityId,
    attemptId,
    nodeId: action.nodeId,
    waitKind: 'human-gate',
    deadlineAt,
    prompt: action.humanGate.prompt,
    onTimeout: action.humanGate.onTimeout,
  });

  return { attemptId, attemptCreated, waitCreated };
}

// ─── dispatchWork ─────────────────────────────────────────────────────────

export type DispatchWorkResult =
  | { kind: 'succeeded'; attemptId: string; outputRef: OutputRef; session: WorkerSessionInfo }
  | {
      kind: 'failed';
      attemptId: string;
      errorClass: ErrorClass;
      errorCode: string;
      errorMessage: string;
      session?: WorkerSessionInfo;
    };

/**
 * Run a work activity end-to-end:
 *   1. write `attemptCreated{work}`
 *   2. for `subagent`: invoke `spawnSubagent`, persist session sidecar,
 *      write `activitySucceeded` or `activityFailed`
 *   3. for `hostExecutor`: v0 placeholder — returns `unsupported` until
 *      Slice E (executor registry) lands.  Caller can decide to surface
 *      this as a manual error or skip the run.
 *
 * The function does not retry — that's resume.ts's job after a terminal
 * `activityFailed` lands.  Orchestrator will see the failed work
 * activity on its next tick and emit `completeNodeFailed`.
 */
export async function dispatchWork(
  ctx: WorkflowRuntimeContext,
  action: DispatchWorkAction,
  options: { attemptNumber?: number; snapshot?: Snapshot } = {},
): Promise<DispatchWorkResult> {
  const attemptNumber = options.attemptNumber ?? 1;
  const attemptId = workAttemptId(action.activityId, attemptNumber);
  const node = action.node;

  if (node.type === 'hostExecutor') {
    const inputRef = await writeJsonBlob(ctx.log, {
      kind: 'hostExecutor',
      executor: node.executor,
      input: node.input,
    });
    await ctx.log.append({
      runId: ctx.log.runId,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: action.nodeId,
        activityId: action.activityId,
        attemptId,
        attemptNumber,
        inputRef,
      },
    });

    const registered = ctx.hostExecutors?.get(node.executor);
    if (!registered) {
      return failHostExecutor(ctx, action.activityId, attemptId, {
        errorCode: 'UnknownProviderError',
        errorClass: 'manual',
        errorMessage: `hostExecutor '${node.executor}' is not registered.`,
      });
    }

    let parsedInput: unknown;
    try {
      parsedInput = registered.parseInput(node.input);
    } catch (err) {
      return failHostExecutor(ctx, action.activityId, attemptId, {
        errorCode: 'InputValidationFailed',
        errorClass: 'userFault',
        errorMessage: truncateRuntimeErrorMessage(err instanceof Error ? err.message : String(err)),
      });
    }

    await writeEffectInputSidecar(ctx.log, action.activityId, attemptId, parsedInput);
    const identity = await resolveWorkflowIdentity(ctx, options.snapshot);
    const result = await executeRegisteredHostExecutor(
      registered,
      {
        log: ctx.log,
        runId: ctx.log.runId,
        workflowId: identity.workflowId,
        revisionId: identity.revisionId,
        nodeId: action.nodeId,
        activityId: action.activityId,
        attemptId,
      },
      parsedInput,
    );
    if (result.ok) {
      if ('ref' in result.event.payload) {
        throw new Error('hostExecutor activitySucceeded unexpectedly used payload ref');
      }
      return {
        kind: 'succeeded',
        attemptId,
        outputRef: result.event.payload.outputRef,
        session: {
          sessionId: `host-${action.activityId}-${attemptId}`,
          botName: node.executor,
          startedAt: nowMs(ctx),
          endedAt: nowMs(ctx),
        },
      };
    }
    return {
      kind: 'failed',
      attemptId,
      errorClass: result.error.errorClass,
      errorCode: result.error.errorCode,
      errorMessage: result.error.errorMessage,
    };
  }

  // Subagent path: serialize prompt as the input blob.
  const inputRef = await writeJsonBlob(ctx.log, {
    kind: 'subagent',
    bot: node.bot,
    prompt: node.prompt,
  });

  await ctx.log.append({
    runId: ctx.log.runId,
    type: 'attemptCreated',
    actor: 'scheduler',
    payload: {
      nodeId: action.nodeId,
      activityId: action.activityId,
      attemptId,
      attemptNumber,
      inputRef,
    },
  });

  // NB: skipping `leaseSigned` + `activityRunning` in v0 — those are
  // tied to the lease-timeout enforcement path (Step 6) which we
  // don't engage when the spawn callback runs inline and synchronously
  // settles into success/failure.  Re-introduce when leases are wired
  // (Slice D / runtime-loop slice).

  const botSnapshot = await resolveBotSnapshot(ctx, node.bot, options.snapshot);
  const spawnResult = await ctx.spawnSubagent({
    botName: node.bot,
    botSnapshot,
    // Per UI doc §3.4 "freeze identity": prefer the snapshot's workingDir
    // (frozen at runCreated) over current bot-registry state.  Node-level
    // override still wins — author intent on a specific step beats the
    // run-wide bot default.
    workingDir: node.workingDir ?? botSnapshot?.workingDir,
    prompt: node.prompt,
    modelOverrides: node.modelOverrides,
    toolPolicy: node.toolPolicy,
    activityId: action.activityId,
    attemptId,
    nodeId: action.nodeId,
    runId: ctx.log.runId,
  });

  if (spawnResult.session) {
    await writeSessionSidecar(ctx.log, action.activityId, attemptId, spawnResult.session);
  }

  if (spawnResult.kind === 'success') {
    const outputRef = await writeJsonBlob(ctx.log, spawnResult.output);
    await ctx.log.append({
      runId: ctx.log.runId,
      type: 'activitySucceeded',
      actor: 'worker',
      payload: {
        activityId: action.activityId,
        attemptId,
        outputRef,
      },
    });
    return { kind: 'succeeded', attemptId, outputRef, session: spawnResult.session };
  }

  await ctx.log.append({
    runId: ctx.log.runId,
    type: 'activityFailed',
    actor: 'worker',
    payload: {
      activityId: action.activityId,
      attemptId,
      error: {
        errorCode: spawnResult.errorCode,
        errorClass: spawnResult.errorClass,
        errorMessage: spawnResult.errorMessage,
      },
    },
  });
  return {
    kind: 'failed',
    attemptId,
    errorClass: spawnResult.errorClass,
    errorCode: spawnResult.errorCode,
    errorMessage: spawnResult.errorMessage,
    session: spawnResult.session,
  };
}

function truncateRuntimeErrorMessage(msg: string): string {
  const max = 2048;
  return msg.length > max ? msg.slice(0, max - 3) + '...' : msg;
}

// ─── completeNodeSucceeded ───────────────────────────────────────────────

export async function completeNodeSucceeded(
  ctx: WorkflowRuntimeContext,
  action: CompleteNodeSucceededAction,
): Promise<NodeSucceededEvent> {
  return (await ctx.log.append({
    runId: ctx.log.runId,
    type: 'nodeSucceeded',
    actor: 'scheduler',
    payload: {
      nodeId: action.nodeId,
      lastActivityId: action.lastActivityId,
    },
  })) as NodeSucceededEvent;
}

// ─── completeNodeFailed ───────────────────────────────────────────────────

// NB: nodeFailed payload (events doc v0.1.2) has no rootCauseEventId
// field — that lives on runFailed only.  If/when the spec adds it to
// nodeFailed, lift `findRootCauseEventId` to take an activityId and
// reuse it here.

export async function completeNodeFailed(
  ctx: WorkflowRuntimeContext,
  action: CompleteNodeFailedAction,
): Promise<NodeFailedEvent> {
  return (await ctx.log.append({
    runId: ctx.log.runId,
    type: 'nodeFailed',
    actor: 'scheduler',
    payload: {
      nodeId: action.nodeId,
      lastActivityId: action.lastActivityId,
      errorClass: action.errorClass,
    },
  })) as NodeFailedEvent;
}

// ─── completeRunSucceeded ─────────────────────────────────────────────────

export async function completeRunSucceeded(
  ctx: WorkflowRuntimeContext,
  action: CompleteRunSucceededAction,
): Promise<RunSucceededEvent> {
  return (await ctx.log.append({
    runId: ctx.log.runId,
    type: 'runSucceeded',
    actor: 'scheduler',
    payload: { outputRef: action.outputRef },
  })) as RunSucceededEvent;
}

// ─── completeRunFailed ────────────────────────────────────────────────────

async function findRootCauseEventId(
  ctx: WorkflowRuntimeContext,
  nodeId: string,
): Promise<string> {
  const events = await ctx.log.readAll();
  // Prefer the activityFailed under the failed node's last activity.
  // Fall back to the nodeFailed event itself (always exists by now).
  let nodeFailedEventId: string | undefined;
  let activityFailedEventId: string | undefined;
  const nodeActivities = new Set<string>();
  for (const e of events) {
    if (e.type === 'attemptCreated') {
      const p = (e as AttemptCreatedEvent).payload;
      if (!('ref' in p) && p.nodeId === nodeId) nodeActivities.add(p.activityId);
    } else if (e.type === 'activityFailed') {
      const p = (e as ActivityFailedEvent).payload;
      if (!('ref' in p) && nodeActivities.has(p.activityId)) {
        activityFailedEventId = e.eventId;
      }
    } else if (e.type === 'nodeFailed') {
      const p = (e as NodeFailedEvent).payload;
      if (!('ref' in p) && p.nodeId === nodeId) {
        nodeFailedEventId = e.eventId;
      }
    }
  }
  return activityFailedEventId ?? nodeFailedEventId ?? events[0]!.eventId;
}

export async function completeRunFailed(
  ctx: WorkflowRuntimeContext,
  action: CompleteRunFailedAction,
): Promise<RunFailedEvent> {
  const rootCauseEventId = await findRootCauseEventId(ctx, action.failedNodeId);
  return (await ctx.log.append({
    runId: ctx.log.runId,
    type: 'runFailed',
    actor: 'scheduler',
    payload: {
      failedNodeId: action.failedNodeId,
      rootCauseEventId,
    },
  })) as RunFailedEvent;
}

// ─── Re-export selected pieces for callers ────────────────────────────────

export type { Snapshot };
export { replay };

// `RunCanceledEvent` import kept stable for Slice D / future cancel
// fan-out wiring; intentional unused reference.
type _UnusedRunCanceled = RunCanceledEvent;
