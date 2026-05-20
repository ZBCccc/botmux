/**
 * Orchestrator loop runner.
 *
 * Drives `decideNextActions → dispatch* → replay → repeat` until either
 * the run reaches a terminal status or the orchestrator returns no
 * actions (which on a non-terminal run means we're paused on an open
 * `waitCreated`).
 *
 * The loop is **synchronous in event-log terms** — every action it
 * dispatches synchronously writes one or more events before the next
 * tick reads the log.  Concurrency is bounded to a single in-flight
 * action per tick; multi-action parallelism is a Slice D+ optimization.
 *
 * Re-entry: external events (e.g. `waitResolved` written by the lark
 * card handler) don't drive this loop — the caller is responsible for
 * invoking `runLoop` again when it knows new events have landed.  See
 * `src/workflows/fanout.ts` (Slice D-4) for the daemon-side trigger.
 */

import {
  decideNextActions,
  type OrchestratorAction,
} from './orchestrator.js';
import { replay, type Snapshot } from './events/replay.js';
import { resume } from './resume.js';
import {
  completeNodeFailed,
  completeNodeSucceeded,
  completeRunFailed,
  completeRunSucceeded,
  dispatchGate,
  dispatchWork,
  type WorkflowRuntimeContext,
} from './runtime.js';
import { logger } from '../utils/logger.js';

export type RunLoopStopReason =
  | 'terminal' // run reached succeeded / failed / cancelled
  | 'awaiting-wait' // open waitCreated; need external resolveWait to continue
  | 'no-progress' // non-terminal but orchestrator emitted [] without a wait
  | 'max-ticks'; // defensive cap hit — likely a bug

export type RunLoopResult = {
  reason: RunLoopStopReason;
  ticks: number;
  lastSnapshot: Snapshot;
};

export type RunLoopOptions = {
  /**
   * Defensive cap on tick count.  A correctly modeled workflow with N
   * nodes terminates in O(N) ticks; the cap exists to keep buggy
   * orchestrator output from spinning forever.  Default 1000.
   */
  maxTicks?: number;
};

export async function runLoop(
  ctx: WorkflowRuntimeContext,
  options: RunLoopOptions = {},
): Promise<RunLoopResult> {
  const maxTicks = options.maxTicks ?? 1000;
  let ticks = 0;
  let snapshot: Snapshot = replay(await ctx.log.readAll());

  while (ticks < maxTicks) {
    if (isTerminalStatus(snapshot)) {
      return { reason: 'terminal', ticks, lastSnapshot: snapshot };
    }

    // ─── Recovery phase ────────────────────────────────────────────────
    // Side-effect family contract: `effectAttempted` written, terminal
    // missing.  Run resume() with the registered reconcilers to close
    // those out before any forward decision.  Without reconcilers we
    // CANNOT silently proceed — the dangling effect represents real
    // external state we'd be ignoring.
    const danglingCancelSet = new Set(snapshot.danglingCancels);
    const danglingRecoverableActivities = snapshot.danglingActivities.filter(
      (activityId) =>
        !snapshot.danglingWaits.includes(activityId) || danglingCancelSet.has(activityId),
    );
    if (
      snapshot.danglingEffectAttempted.length > 0 ||
      danglingRecoverableActivities.length > 0
    ) {
      if (
        snapshot.danglingEffectAttempted.length > 0 &&
        (!ctx.reconcilers || ctx.reconcilers.size === 0)
      ) {
        logger.warn?.(
          `runLoop(${ctx.log.runId}): danglingEffectAttempted=${snapshot.danglingEffectAttempted.length} but ctx.reconcilers missing/empty — stopping with no-progress.`,
        );
        return { reason: 'no-progress', ticks, lastSnapshot: snapshot };
      }
      const before = new Set(snapshot.danglingEffectAttempted);
      const beforeRecoverable = new Set(danglingRecoverableActivities);
      await resume({
        log: ctx.log,
        runId: ctx.log.runId,
        daemonId: 'runloop',
        reconcilers: ctx.reconcilers ?? new Map(),
        loadEffectInput: ctx.loadEffectInput,
        now: ctx.now,
      });
      snapshot = replay(await ctx.log.readAll());
      // If the same set of dangling effects survived recovery, the
      // reconcilers concluded manual/transient.  Don't dispatch new work
      // — operator needs to look at the failed reconcile evidence.
      const stillDangling = snapshot.danglingEffectAttempted.filter((a) => before.has(a));
      if (before.size > 0 && stillDangling.length === before.size) {
        logger.warn?.(
          `runLoop(${ctx.log.runId}): resume() made no progress on ${stillDangling.length} dangling effect(s) — stopping with no-progress.`,
        );
        return { reason: 'no-progress', ticks, lastSnapshot: snapshot };
      }
      if (before.size === 0 && beforeRecoverable.size > 0) {
        const afterCancelSet = new Set(snapshot.danglingCancels);
        const stillRecoverable = snapshot.danglingActivities.filter(
          (activityId) =>
            beforeRecoverable.has(activityId) &&
            (!snapshot.danglingWaits.includes(activityId) || afterCancelSet.has(activityId)),
        );
        if (stillRecoverable.length === beforeRecoverable.size) {
          logger.warn?.(
            `runLoop(${ctx.log.runId}): resume() made no progress on ${stillRecoverable.length} dangling non-effect activity/activities — stopping with no-progress.`,
          );
          return { reason: 'no-progress', ticks, lastSnapshot: snapshot };
        }
      }
      // Progress made; re-enter loop with fresh snapshot before
      // computing actions.
      continue;
    }

    const actions = decideNextActions(snapshot, ctx.def);
    if (actions.length === 0) {
      // Empty actions on a non-terminal run: must be waiting on a
      // human gate or open wait.  Distinguish from "stuck" (no waits
      // but also no actions) via danglingWaits — at least one open.
      const stopped: RunLoopStopReason =
        snapshot.danglingWaits.length > 0 ? 'awaiting-wait' : 'no-progress';
      return { reason: stopped, ticks, lastSnapshot: snapshot };
    }

    for (const action of actions) {
      await dispatchAction(ctx, action, snapshot);
    }

    snapshot = replay(await ctx.log.readAll());
    ticks++;
  }

  // Edge case: the tick that hit maxTicks may itself have written the
  // run terminal.  Prefer the precise reason over the safety-cap reason.
  if (isTerminalStatus(snapshot)) {
    return { reason: 'terminal', ticks, lastSnapshot: snapshot };
  }
  return { reason: 'max-ticks', ticks, lastSnapshot: snapshot };
}

function isTerminalStatus(snapshot: Snapshot): boolean {
  return (
    snapshot.run.status === 'succeeded' ||
    snapshot.run.status === 'failed' ||
    snapshot.run.status === 'cancelled'
  );
}

async function dispatchAction(
  ctx: WorkflowRuntimeContext,
  action: OrchestratorAction,
  snapshot: Snapshot,
): Promise<void> {
  switch (action.kind) {
    case 'dispatchGate':
      await dispatchGate(ctx, action);
      return;
    case 'dispatchWork':
      await dispatchWork(ctx, action, { snapshot });
      return;
    case 'completeNodeSucceeded':
      await completeNodeSucceeded(ctx, action);
      return;
    case 'completeNodeFailed':
      await completeNodeFailed(ctx, action);
      return;
    case 'completeRunSucceeded':
      await completeRunSucceeded(ctx, action);
      return;
    case 'completeRunFailed':
      await completeRunFailed(ctx, action);
      return;
  }
  // Exhaustive — TS will flag if a new action kind is added without
  // a branch.
  const _exhaustive: never = action;
  void _exhaustive;
}
