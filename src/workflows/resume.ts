/**
 * Resume + reconcile algorithm (events doc v0.1.2 §4.3 + §4.3.1).
 *
 * Entry point for daemon restart / hand-off.  Walks the event log,
 * replays a snapshot, then drives reconcile decisions for each dangling
 * `effectAttempted` and writes terminal events for `pure skill`
 * activities that crashed mid-flight (workerLost path).
 *
 * Step 7 boundaries:
 *   - Resume DOES NOT execute activity logic; reconcile uses provider
 *     capabilities (`readOnlyLookup` / `idempotentSubmit`) to decide
 *     terminal state without re-issuing user-visible work beyond what
 *     idempotency guarantees.
 *   - Resume DOES NOT decide retry policy.  A `freshRetry` decision
 *     leaves the attempt dangling — the scheduler (Step 8+) is
 *     responsible for spawning the actual replacement attempt.
 *   - Dangling waits are left alone (waiting for external signal).
 *
 * Round 1 fixes (codex review of `1d14081`):
 *   F1 — replay surfaces the latest reconcileResult per attempt; resume
 *        consumes it before re-running the decision tree, so a crash
 *        between reconcileResult and the terminal event is recoverable.
 *   F2 — reconcilers receive the materialized effect input via the
 *        caller-supplied `loadEffectInput` callback.  Reconcilers that
 *        require input (e.g. Feishu — chatId/rootMessageId/content can't
 *        be reconstructed from idempotencyKey alone) fail explicitly
 *        when input is unrecoverable.
 *   F3 — `retryable` failures from idempotentSubmit do NOT terminate
 *        the attempt; the activity stays dangling and is surfaced in
 *        `ResumeResult.transientFailures` for the caller to retry.
 *   F4 — `resumeStarted` is written ONLY after a preflight validates
 *        the log is replayable; bad inputs throw without polluting the
 *        run event log.
 */

import type { EventLog } from './events/append.js';
import { replay, type Snapshot, type AttemptState } from './events/replay.js';
import type {
  ActivityFailedEvent,
  ActivitySucceededEvent,
  ReconcileResultEvent,
  ResumeStartedEvent,
} from './events/types.js';

// ─── Public surface ─────────────────────────────────────────────────────────

export type ReconcileCapability = 'readOnlyLookup' | 'idempotentSubmit' | 'none';

export type ReconcileDecision =
  | 'replayed'
  | 'completedByIdempotentSubmit'
  | 'manual'
  | 'freshRetry';

export type ReadOnlyLookupResult =
  | { found: true; externalRefs: Record<string, unknown>; evidence?: Record<string, unknown> }
  | { found: false; evidence?: Record<string, unknown> };

export type IdempotentSubmitResult =
  | { ok: true; externalRefs: Record<string, unknown>; evidence?: Record<string, unknown> }
  | {
      ok: false;
      errorCode: string;
      errorClass: 'retryable' | 'fatal' | 'userFault' | 'manual';
      errorMessage: string;
      evidence?: Record<string, unknown>;
    };

/**
 * Per-provider capability bundle.  Resume looks up the reconciler by the
 * `effectAttempted.provider` field; missing entries fall through to
 * manual/UnknownProviderError.
 *
 * Reconcilers receive the materialized effect input alongside the
 * idempotencyKey: providers like Feishu can't re-construct the request
 * body from the key alone (the key is a hash, not the body).  When the
 * caller doesn't supply `loadEffectInput`, resume treats the input as
 * `undefined`; reconcilers that NEED input MUST declare so via
 * `requiresEffectInput` so resume can fail fast with a clear error
 * instead of letting the reconciler silently misbehave.
 */
export interface ProviderReconciler {
  readonly provider: string;
  /**
   * When `true`, resume refuses to call this reconciler without a
   * materialized effect input — i.e. it writes manual/InputUnrecoverable
   * if `loadEffectInput` is absent or throws.  Feishu sets this; schedule
   * does not (idempotencyKey is the full key).
   */
  readonly requiresEffectInput?: boolean;
  /**
   * Pure read against the provider keyed by `idempotencyKey`.  Has no
   * side effects; safe to call from resume even when we don't intend to
   * complete the effect.  Schedule has it (`getTask(id)`); Feishu does
   * not (no uuid-reverse-lookup API).
   */
  readOnlyLookup?(idempotencyKey: string, input: unknown): Promise<ReadOnlyLookupResult>;
  /**
   * Re-submit the effect with the same `idempotencyKey`.  MAY produce
   * the side effect for real (if the original pre-invoke crash never
   * reached the provider); provider dedupe inside TTL guarantees the
   * second submit returns the original ref instead of a duplicate.
   */
  idempotentSubmit?(idempotencyKey: string, input: unknown): Promise<IdempotentSubmitResult>;
}

export type ResumeContext = {
  /** Authoritative event log for this run.  Resume writes events into it. */
  log: EventLog;
  /** Match `log.runId`; passed explicitly so the contract is visible. */
  runId: string;
  /** Daemon identifier for the resumeStarted audit event. */
  daemonId: string;
  /** Reconcilers keyed by provider name (`feishu-im`, `botmux-schedule`). */
  reconcilers: Map<string, ProviderReconciler>;
  /**
   * Load the materialized effect input that was passed to the original
   * attempt.  Required for providers that re-submit (Feishu).  Resume
   * passes the returned value to the reconciler's readOnlyLookup /
   * idempotentSubmit.
   *
   * v0: the caller (daemon) decides where to persist or recover this —
   * in-memory while alive, or some external storage on cold start.
   * Resume only consumes the callback.
   *
   * Returning `undefined` is treated as "input unrecoverable" and
   * triggers the manual/InputUnrecoverable path for reconcilers that
   * declared `requiresEffectInput`.
   */
  loadEffectInput?(activityId: string, attemptId: string): Promise<unknown>;
  /** Injectable clock for deterministic tests.  Defaults to Date.now. */
  now?: () => number;
};

export type ReconcileOutcome = {
  activityId: string;
  attemptId: string;
  idempotencyKey: string;
  provider: string;
  capability: ReconcileCapability;
  decision: ReconcileDecision;
  evidence: Record<string, unknown>;
  /**
   * Terminal event written as a consequence.  null for `replayed` (the
   * pre-existing terminal IS the consequence) and `freshRetry` (scheduler
   * issues a new attempt later, not Step 7's job).
   */
  terminalEvent: ActivitySucceededEvent | ActivityFailedEvent | null;
  /** The reconcileResult event written, or null if this outcome reused
   *  a pre-existing reconcileResult (recovery path — codex F1). */
  reconcileEvent: ReconcileResultEvent | null;
  /** True when this outcome recovered a prior crashed reconcile cycle
   *  rather than running the decision tree from scratch. */
  recovered: boolean;
};

export type WorkerCrashedOutcome = {
  activityId: string;
  attemptId: string;
  terminalEvent: ActivityFailedEvent;
};

/**
 * Recovery of a wait whose resolution event landed but whose activity
 * terminal was never written (crash between `waitResolved` /
 * `waitDeadlineExceeded` and the terminal).  Step 8: replay surfaces
 * these as `Snapshot.danglingWaitResolutions`; resume materializes the
 * terminal from the recorded resolution.
 */
export type WaitRecoveryOutcome = {
  activityId: string;
  attemptId: string;
  /** What the recovery decided to write. */
  kind: 'succeeded' | 'failed';
  source: 'resolved' | 'deadlineExceeded';
  terminalEvent: ActivitySucceededEvent | ActivityFailedEvent;
};

/**
 * Reconcile failures that resume DELIBERATELY does not terminate (codex
 * F3): a retryable provider failure during idempotentSubmit might mean
 * "request landed, response lost", and writing a manual terminal there
 * would freeze the activity in a wrong terminal state.  Resume reports
 * these back to the caller and leaves the activity dangling so the next
 * resume cycle can retry.
 */
export type TransientReconcileFailure = {
  activityId: string;
  attemptId: string;
  provider: string;
  idempotencyKey: string;
  errorCode: string;
  errorClass: 'retryable';
  errorMessage: string;
};

export type ResumeResult = {
  resumeStartedEvent: ResumeStartedEvent;
  /** Snapshot captured after `resumeStarted` is appended.  Returned for
   *  observability — caller can inspect dangling sets it consumed. */
  snapshot: Snapshot;
  reconcileOutcomes: ReconcileOutcome[];
  workerCrashedOutcomes: WorkerCrashedOutcome[];
  transientFailures: TransientReconcileFailure[];
  waitRecoveryOutcomes: WaitRecoveryOutcome[];
};

// ─── Resume orchestrator ────────────────────────────────────────────────────

export async function resume(ctx: ResumeContext): Promise<ResumeResult> {
  if (ctx.runId !== ctx.log.runId) {
    throw new Error(
      `resume: ctx.runId (${ctx.runId}) does not match log.runId (${ctx.log.runId})`,
    );
  }
  const now = ctx.now ?? Date.now;

  // F4: Preflight BEFORE writing resumeStarted.  Bad logs (empty / no
  // runCreated / cross-runId contamination) throw without polluting the
  // run event log — audit goes to the daemon logger, not the canonical
  // per-run event stream.
  const preEvents = await ctx.log.readAll();
  if (preEvents.length === 0) {
    throw new Error(
      `resume(${ctx.runId}): cannot resume an empty event log — no runCreated to project from.`,
    );
  }
  if (preEvents[0].type !== 'runCreated') {
    throw new Error(
      `resume(${ctx.runId}): first event must be runCreated, got ${preEvents[0].type} (corrupt log; not appending resumeStarted).`,
    );
  }
  // We let `replay` enforce cross-runId, but check up front so the
  // diagnostic is colocated with the preflight.
  if (preEvents[0].runId !== ctx.runId) {
    throw new Error(
      `resume(${ctx.runId}): runCreated.runId is ${preEvents[0].runId}, log/ctx are ${ctx.runId} (corrupt log; not appending resumeStarted).`,
    );
  }

  // Preflight passed — now write the audit entry.
  const resumeStartedEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'resumeStarted',
    actor: 'system',
    payload: {
      daemonId: ctx.daemonId,
      lastSeenEventId: preEvents[preEvents.length - 1].eventId,
    },
  })) as ResumeStartedEvent;

  // Re-read so the snapshot includes the resumeStarted (replay treats
  // it as a no-op projection — keeping the read consistent).
  const allEvents = await ctx.log.readAll();
  const snapshot = replay(allEvents);

  const reconcileOutcomes: ReconcileOutcome[] = [];
  const transientFailures: TransientReconcileFailure[] = [];
  for (const activityId of snapshot.danglingEffectAttempted) {
    const result = await reconcileOne(ctx, snapshot, activityId, now());
    if (result.kind === 'outcome') reconcileOutcomes.push(result.outcome);
    else if (result.kind === 'transient') transientFailures.push(result.failure);
  }

  // Step 8: wait recovery — `waitResolved` / `waitDeadlineExceeded`
  // landed but the activity terminal didn't.  Materialize the terminal
  // from the recorded resolution so the next replay sees a clean
  // terminal state.
  const waitRecoveryOutcomes: WaitRecoveryOutcome[] = [];
  for (const activityId of snapshot.danglingWaitResolutions) {
    const recovery = await recoverWaitResolution(ctx, snapshot, activityId);
    if (recovery) waitRecoveryOutcomes.push(recovery);
  }

  // Worker-crashed path: dangling activity, no effectAttempted, no
  // open wait, no recoverable wait resolution → activityFailed{WorkerCrashed, retryable}.
  const workerCrashedOutcomes: WorkerCrashedOutcome[] = [];
  const reconciled = new Set(snapshot.danglingEffectAttempted);
  const waitingActivities = new Set(snapshot.danglingWaits);
  const waitRecovered = new Set(snapshot.danglingWaitResolutions);
  for (const activityId of snapshot.danglingActivities) {
    if (reconciled.has(activityId)) continue;
    if (waitingActivities.has(activityId)) continue;
    if (waitRecovered.has(activityId)) continue;
    const activity = snapshot.activities.get(activityId);
    if (!activity) continue;
    const latest = activity.attempts[activity.attempts.length - 1];
    if (!latest) continue;
    const terminalEvent = (await ctx.log.append({
      runId: ctx.runId,
      type: 'activityFailed',
      actor: 'system',
      payload: {
        activityId,
        attemptId: latest.attemptId,
        error: {
          errorCode: 'WorkerCrashed',
          errorClass: 'retryable',
          errorMessage: 'Worker process exited before the activity reached a terminal state.',
        },
      },
    })) as ActivityFailedEvent;
    workerCrashedOutcomes.push({ activityId, attemptId: latest.attemptId, terminalEvent });
  }

  return {
    resumeStartedEvent,
    snapshot,
    reconcileOutcomes,
    workerCrashedOutcomes,
    transientFailures,
    waitRecoveryOutcomes,
  };
}

// ─── Wait recovery (Step 8) ────────────────────────────────────────────────

async function recoverWaitResolution(
  ctx: ResumeContext,
  snapshot: Snapshot,
  activityId: string,
): Promise<WaitRecoveryOutcome | null> {
  const activity = snapshot.activities.get(activityId);
  if (!activity) return null;
  const latest = activity.attempts[activity.attempts.length - 1];
  if (!latest?.wait?.resolution) return null;
  const r = latest.wait.resolution;

  if (r.kind === 'resolved') {
    // approved | external → activitySucceeded.
    // rejected           → activityFailed { InputValidationFailed, userFault }.
    if (r.resolution === 'rejected') {
      const terminalEvent = (await ctx.log.append({
        runId: ctx.runId,
        type: 'activityFailed',
        actor: 'system',
        payload: {
          activityId,
          attemptId: latest.attemptId,
          error: {
            errorCode: 'InputValidationFailed',
            errorClass: 'userFault',
            errorMessage: `Recovered wait terminal: rejected by ${r.by}${
              r.comment ? `: ${r.comment}` : ''
            }`,
          },
        },
      })) as ActivityFailedEvent;
      return {
        activityId,
        attemptId: latest.attemptId,
        kind: 'failed',
        source: 'resolved',
        terminalEvent,
      };
    }
    // approved | external
    const externalRefs: Record<string, unknown> = {
      resolution: r.resolution,
      by: r.by,
      ...(r.comment ? { comment: r.comment } : {}),
    };
    const terminalEvent = await writeRecoverySucceeded(
      ctx,
      activityId,
      latest.attemptId,
      externalRefs,
    );
    return {
      activityId,
      attemptId: latest.attemptId,
      kind: 'succeeded',
      source: 'resolved',
      terminalEvent,
    };
  }

  // deadlineExceeded
  const policy = latest.wait.onTimeout ?? 'fail';
  if (policy === 'success') {
    const externalRefs = { defaultedToTimeout: true, deadlineAt: r.deadlineAt };
    const terminalEvent = await writeRecoverySucceeded(
      ctx,
      activityId,
      latest.attemptId,
      externalRefs,
    );
    return {
      activityId,
      attemptId: latest.attemptId,
      kind: 'succeeded',
      source: 'deadlineExceeded',
      terminalEvent,
    };
  }
  const terminalEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'activityFailed',
    actor: 'system',
    payload: {
      activityId,
      attemptId: latest.attemptId,
      error: {
        errorCode: 'WaitDeadlineExceeded',
        errorClass: 'userFault',
        errorMessage: `Recovered wait terminal: deadline (${r.deadlineAt}) exceeded at ${r.exceededAtMs}`,
      },
    },
  })) as ActivityFailedEvent;
  return {
    activityId,
    attemptId: latest.attemptId,
    kind: 'failed',
    source: 'deadlineExceeded',
    terminalEvent,
  };
}

async function writeRecoverySucceeded(
  ctx: ResumeContext,
  activityId: string,
  attemptId: string,
  externalRefs: Record<string, unknown>,
): Promise<ActivitySucceededEvent> {
  const outputBuf = Buffer.from(JSON.stringify(externalRefs), 'utf-8');
  const outputHash = await sha256Hex(outputBuf);
  return (await ctx.log.append({
    runId: ctx.runId,
    type: 'activitySucceeded',
    actor: 'system',
    payload: {
      activityId,
      attemptId,
      outputRef: {
        outputHash: `sha256:${outputHash}`,
        outputBytes: outputBuf.length,
        outputSchemaVersion: 1,
        contentType: 'application/json',
      },
      externalRefs,
    },
  })) as ActivitySucceededEvent;
}

// ─── Reconcile decision tree ────────────────────────────────────────────────

type ReconcileStepResult =
  | { kind: 'outcome'; outcome: ReconcileOutcome }
  | { kind: 'transient'; failure: TransientReconcileFailure }
  | { kind: 'skipped' };

async function reconcileOne(
  ctx: ResumeContext,
  snapshot: Snapshot,
  activityId: string,
  nowMs: number,
): Promise<ReconcileStepResult> {
  const activity = snapshot.activities.get(activityId);
  if (!activity) return { kind: 'skipped' };
  const latest = activity.attempts[activity.attempts.length - 1];
  if (!latest || !latest.effectAttempted) return { kind: 'skipped' };

  const ea = latest.effectAttempted;

  // F1: recovery path — if a previous resume already wrote a
  // reconcileResult for this attempt but crashed before the terminal,
  // resume the consequences instead of re-running the decision tree.
  // Re-running risks a DIFFERENT decision (TTL crosses, provider state
  // changes), so we honor the recorded choice.
  if (latest.latestReconcileResult) {
    return recoverFromReconcileResult(ctx, activityId, latest, ea);
  }

  const reconciler = ctx.reconcilers.get(ea.provider);

  // Case A — unknown provider.  No way to confirm; manual/UnknownProvider.
  if (!reconciler) {
    return outcome(
      await writeManual(
        ctx,
        activityId,
        latest.attemptId,
        ea.idempotencyKey,
        ea.provider,
        'none',
        'UnknownProviderError',
        `No reconciler registered for provider "${ea.provider}".`,
        { reason: 'no_reconciler' },
      ),
    );
  }

  // Case B — TTL boundary.  Use the recorded TTL from effectAttempted,
  // not the live reconciler's value: the provider's TTL may have changed
  // between the attempt and this resume, but the contract that was in
  // force at attempt time is what matters.
  const ttlExpired = nowMs - ea.attemptedAtMs > ea.idempotencyTtlMs;
  if (ttlExpired) {
    return outcome(
      await writeManual(
        ctx,
        activityId,
        latest.attemptId,
        ea.idempotencyKey,
        ea.provider,
        'none',
        'TtlExpired',
        `Provider TTL (${ea.idempotencyTtlMs}ms) elapsed before resume could reconcile.`,
        {
          reason: 'ttl_expired',
          attemptedAtMs: ea.attemptedAtMs,
          nowMs,
          idempotencyTtlMs: ea.idempotencyTtlMs,
        },
      ),
    );
  }

  // F2: materialize effect input via the caller's loader.  Some
  // reconcilers can work without it (schedule); others (Feishu) MUST
  // have it.
  let effectInput: unknown = undefined;
  let inputLoadError: Error | null = null;
  if (ctx.loadEffectInput) {
    try {
      effectInput = await ctx.loadEffectInput(activityId, latest.attemptId);
    } catch (err) {
      inputLoadError = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (
    reconciler.requiresEffectInput &&
    (inputLoadError !== null || effectInput === undefined)
  ) {
    return outcome(
      await writeManual(
        ctx,
        activityId,
        latest.attemptId,
        ea.idempotencyKey,
        ea.provider,
        'none',
        'InputUnrecoverable',
        inputLoadError
          ? `Failed to load effect input for reconcile: ${inputLoadError.message}`
          : `Reconciler "${ea.provider}" requires effect input, but ctx.loadEffectInput returned undefined / was not provided.`,
        { reason: 'input_unrecoverable', hadLoader: !!ctx.loadEffectInput },
      ),
    );
  }

  // Case C — readOnlyLookup available.  Prefer it: pure read, no side
  // effect risk.  Schedule has it.
  if (reconciler.readOnlyLookup) {
    const lookup = await reconciler.readOnlyLookup(ea.idempotencyKey, effectInput);
    if (lookup.found) {
      return outcome(
        await writeCompletedByIdempotentSubmit(
          ctx,
          activityId,
          latest.attemptId,
          ea.idempotencyKey,
          ea.provider,
          'readOnlyLookup',
          lookup.externalRefs,
          lookup.evidence ?? {},
        ),
      );
    }
    return outcome(
      await writeFreshRetry(
        ctx,
        activityId,
        latest.attemptId,
        ea.idempotencyKey,
        ea.provider,
        'readOnlyLookup',
        lookup.evidence ?? { found: false },
      ),
    );
  }

  // Case D — idempotentSubmit only (Feishu).
  if (reconciler.idempotentSubmit) {
    const submit = await reconciler.idempotentSubmit(ea.idempotencyKey, effectInput);
    if (submit.ok) {
      return outcome(
        await writeCompletedByIdempotentSubmit(
          ctx,
          activityId,
          latest.attemptId,
          ea.idempotencyKey,
          ea.provider,
          'idempotentSubmit',
          submit.externalRefs,
          submit.evidence ?? {},
        ),
      );
    }
    // F3: retryable failures stay dangling.  Provider may have received
    // the request and dropped the response; writing manual terminal
    // would freeze the activity in a wrong state and short-circuit the
    // next resume from retrying.  We log to the caller as a transient
    // failure and let the activity remain dangling.
    if (submit.errorClass === 'retryable') {
      return {
        kind: 'transient',
        failure: {
          activityId,
          attemptId: latest.attemptId,
          provider: ea.provider,
          idempotencyKey: ea.idempotencyKey,
          errorCode: submit.errorCode,
          errorClass: 'retryable',
          errorMessage: submit.errorMessage,
        },
      };
    }
    // fatal / userFault / manual — these are decisive; write manual
    // terminal so a human inspects.  Note the manual escalation here is
    // intentional and bounded to non-retryable cases.
    return outcome(
      await writeManual(
        ctx,
        activityId,
        latest.attemptId,
        ea.idempotencyKey,
        ea.provider,
        'idempotentSubmit',
        submit.errorCode,
        submit.errorMessage,
        submit.evidence ?? { errorClass: submit.errorClass },
      ),
    );
  }

  // Case E — reconciler exists but exposes no capability.  Manual.
  return outcome(
    await writeManual(
      ctx,
      activityId,
      latest.attemptId,
      ea.idempotencyKey,
      ea.provider,
      'none',
      'UnknownProviderError',
      `Reconciler for "${ea.provider}" exposes neither readOnlyLookup nor idempotentSubmit.`,
      { reason: 'no_capability' },
    ),
  );
}

function outcome(o: ReconcileOutcome): ReconcileStepResult {
  return { kind: 'outcome', outcome: o };
}

// ─── F1 recovery: a prior reconcileResult exists, terminal does not ─────────

async function recoverFromReconcileResult(
  ctx: ResumeContext,
  activityId: string,
  latest: AttemptState,
  ea: NonNullable<AttemptState['effectAttempted']>,
): Promise<ReconcileStepResult> {
  const rr = latest.latestReconcileResult!;
  switch (rr.decision) {
    case 'completedByIdempotentSubmit': {
      // Re-derive externalRefs from the recorded evidence.  We wrote it
      // there during the first resume so this recovery is decoupled
      // from the provider being reachable now.
      //
      // STRICT validation (codex round 2 of Step 7): if evidence
      // doesn't carry a usable externalRefs object, this is a corrupt
      // reconcileResult — falling back to `{}` would silently materialize
      // a fake activitySucceeded with an empty external ref, turning log
      // corruption into a fake success.  Treat as CorruptLog manual
      // instead so the inconsistency surfaces.
      const evidence = rr.evidence;
      const candidate = (evidence as { externalRefs?: unknown }).externalRefs;
      if (
        candidate === undefined ||
        candidate === null ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      ) {
        const terminalEvent = (await ctx.log.append({
          runId: ctx.runId,
          type: 'activityFailed',
          actor: 'system',
          payload: {
            activityId,
            attemptId: latest.attemptId,
            error: {
              errorCode: 'CorruptLog',
              errorClass: 'manual',
              errorMessage:
                'Prior reconcileResult{decision=completedByIdempotentSubmit} is missing evidence.externalRefs (or it is not an object) — refusing to fabricate an activitySucceeded from empty refs.',
            },
          },
        })) as ActivityFailedEvent;
        return outcome({
          activityId,
          attemptId: latest.attemptId,
          idempotencyKey: ea.idempotencyKey,
          provider: ea.provider,
          capability: rr.capability,
          decision: 'manual',
          evidence: {
            ...rr.evidence,
            corruptReason: 'missing_external_refs',
            originalDecision: 'completedByIdempotentSubmit',
            reconcileEventId: rr.eventId,
          },
          terminalEvent,
          reconcileEvent: null,
          recovered: true,
        });
      }
      const externalRefs = candidate as Record<string, unknown>;
      const outputBuf = Buffer.from(JSON.stringify(externalRefs), 'utf-8');
      const outputHash = await sha256Hex(outputBuf);
      const terminalEvent = (await ctx.log.append({
        runId: ctx.runId,
        type: 'activitySucceeded',
        actor: 'system',
        payload: {
          activityId,
          attemptId: latest.attemptId,
          outputRef: {
            outputHash: `sha256:${outputHash}`,
            outputBytes: outputBuf.length,
            outputSchemaVersion: 1,
            contentType: 'application/json',
          },
          externalRefs,
        },
      })) as ActivitySucceededEvent;
      return outcome({
        activityId,
        attemptId: latest.attemptId,
        idempotencyKey: ea.idempotencyKey,
        provider: ea.provider,
        capability: rr.capability,
        decision: 'completedByIdempotentSubmit',
        evidence: rr.evidence,
        terminalEvent,
        reconcileEvent: null,
        recovered: true,
      });
    }
    case 'manual': {
      const evidence = rr.evidence;
      const errorCode =
        (evidence as { errorCode?: string }).errorCode ?? 'UnknownProviderError';
      const terminalEvent = (await ctx.log.append({
        runId: ctx.runId,
        type: 'activityFailed',
        actor: 'system',
        payload: {
          activityId,
          attemptId: latest.attemptId,
          error: {
            errorCode,
            errorClass: 'manual',
            errorMessage: `Recovered from prior crashed reconcile cycle (decision=manual, errorCode=${errorCode}).`,
          },
        },
      })) as ActivityFailedEvent;
      return outcome({
        activityId,
        attemptId: latest.attemptId,
        idempotencyKey: ea.idempotencyKey,
        provider: ea.provider,
        capability: rr.capability,
        decision: 'manual',
        evidence: rr.evidence,
        terminalEvent,
        reconcileEvent: null,
        recovered: true,
      });
    }
    case 'freshRetry': {
      // No terminal to write — scheduler picks up the dangling attempt
      // (the prior reconcileResult survived the crash and is the
      // authoritative decision).
      return outcome({
        activityId,
        attemptId: latest.attemptId,
        idempotencyKey: ea.idempotencyKey,
        provider: ea.provider,
        capability: rr.capability,
        decision: 'freshRetry',
        evidence: rr.evidence,
        terminalEvent: null,
        reconcileEvent: null,
        recovered: true,
      });
    }
    case 'replayed': {
      // Replayed means a terminal already existed when reconcileResult
      // was written.  If we landed here, that terminal got lost — which
      // is a corrupt-log scenario, not a recoverable one.  Surface as
      // manual to flag the inconsistency.
      const terminalEvent = (await ctx.log.append({
        runId: ctx.runId,
        type: 'activityFailed',
        actor: 'system',
        payload: {
          activityId,
          attemptId: latest.attemptId,
          error: {
            errorCode: 'CorruptLog',
            errorClass: 'manual',
            errorMessage:
              'Prior reconcileResult decision=replayed but no terminal event present — log inconsistency.',
          },
        },
      })) as ActivityFailedEvent;
      return outcome({
        activityId,
        attemptId: latest.attemptId,
        idempotencyKey: ea.idempotencyKey,
        provider: ea.provider,
        capability: rr.capability,
        decision: 'manual',
        evidence: {
          ...rr.evidence,
          originalDecision: 'replayed',
          reconcileEventId: rr.eventId,
        },
        terminalEvent,
        reconcileEvent: null,
        recovered: true,
      });
    }
  }
}

// ─── Event writers (one per terminal decision) ──────────────────────────────

async function writeCompletedByIdempotentSubmit(
  ctx: ResumeContext,
  activityId: string,
  attemptId: string,
  idempotencyKey: string,
  provider: string,
  capability: ReconcileCapability,
  externalRefs: Record<string, unknown>,
  evidence: Record<string, unknown>,
): Promise<ReconcileOutcome> {
  const reconcileEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'reconcileResult',
    actor: 'system',
    payload: {
      activityId,
      idempotencyKey,
      capability,
      decision: 'completedByIdempotentSubmit',
      evidence: { ...evidence, externalRefs },
    },
  })) as ReconcileResultEvent;

  const outputBuf = Buffer.from(JSON.stringify(externalRefs), 'utf-8');
  const outputHash = await sha256Hex(outputBuf);
  const terminalEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'activitySucceeded',
    actor: 'system',
    payload: {
      activityId,
      attemptId,
      outputRef: {
        outputHash: `sha256:${outputHash}`,
        outputBytes: outputBuf.length,
        outputSchemaVersion: 1,
        contentType: 'application/json',
      },
      externalRefs,
    },
  })) as ActivitySucceededEvent;

  return {
    activityId,
    attemptId,
    idempotencyKey,
    provider,
    capability,
    decision: 'completedByIdempotentSubmit',
    evidence,
    terminalEvent,
    reconcileEvent,
    recovered: false,
  };
}

async function writeFreshRetry(
  ctx: ResumeContext,
  activityId: string,
  attemptId: string,
  idempotencyKey: string,
  provider: string,
  capability: ReconcileCapability,
  evidence: Record<string, unknown>,
): Promise<ReconcileOutcome> {
  const reconcileEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'reconcileResult',
    actor: 'system',
    payload: {
      activityId,
      idempotencyKey,
      capability,
      decision: 'freshRetry',
      evidence,
    },
  })) as ReconcileResultEvent;
  return {
    activityId,
    attemptId,
    idempotencyKey,
    provider,
    capability,
    decision: 'freshRetry',
    evidence,
    terminalEvent: null,
    reconcileEvent,
    recovered: false,
  };
}

async function writeManual(
  ctx: ResumeContext,
  activityId: string,
  attemptId: string,
  idempotencyKey: string,
  provider: string,
  capability: ReconcileCapability,
  errorCode: string,
  errorMessage: string,
  evidence: Record<string, unknown>,
): Promise<ReconcileOutcome> {
  const reconcileEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'reconcileResult',
    actor: 'system',
    payload: {
      activityId,
      idempotencyKey,
      capability,
      decision: 'manual',
      evidence: { ...evidence, errorCode },
    },
  })) as ReconcileResultEvent;
  const terminalEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'activityFailed',
    actor: 'system',
    payload: {
      activityId,
      attemptId,
      error: {
        errorCode,
        errorClass: 'manual',
        errorMessage,
      },
    },
  })) as ActivityFailedEvent;
  return {
    activityId,
    attemptId,
    idempotencyKey,
    provider,
    capability,
    decision: 'manual',
    evidence,
    terminalEvent,
    reconcileEvent,
    recovered: false,
  };
}

async function sha256Hex(buf: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buf).digest('hex');
}

// Re-export AttemptState so test fixtures don't need a separate import path.
export type { AttemptState };
