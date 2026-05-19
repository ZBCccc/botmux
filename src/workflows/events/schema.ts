import { z } from 'zod';
import {
  ActorEnum,
  Sha256Schema,
  Sha256Pattern,
  RunCreatedPayload,
  RunStartedPayload,
  RunSucceededPayload,
  RunFailedPayload,
  RunCanceledPayload,
  NodeWaitingPayload,
  NodeRetryingPayload,
  NodeSucceededPayload,
  NodeFailedPayload,
  NodeSkippedPayload,
  NodeCanceledPayload,
  ActivityRunningPayload,
  ActivityWaitingPayload,
  ActivityTimedOutPayload,
  ConditionEvaluatedPayload,
  LeaseSignedPayload,
  AttemptCreatedPayload,
  BackoffScheduledPayload,
  BackoffElapsedPayload,
  EffectAttemptedPayload,
  ActivitySucceededPayload,
  ActivityFailedPayload,
  WaitCreatedPayload,
  WaitResolvedPayload,
  WaitDeadlineExceededPayload,
  CancelRequestedPayload,
  CancelDeliveredPayload,
  ActivityCanceledPayload,
  WorkerLostPayload,
  ResumeStartedPayload,
  ReconcileResultPayload,
} from './payloads.js';

// ─── Payload ref / inline ───────────────────────────────────────────────────

export const PayloadRefSchema = z.object({
  ref: z.string().min(1),
  bytes: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
});
export type PayloadRef = z.infer<typeof PayloadRefSchema>;

export function isPayloadRef(p: unknown): p is PayloadRef {
  return (
    typeof p === 'object' &&
    p !== null &&
    'ref' in p &&
    'bytes' in p &&
    'schemaVersion' in p &&
    !('eventId' in p) // sanity: payload object, not envelope
  );
}

// ─── Envelope ───────────────────────────────────────────────────────────────

// eventId = `<runId>-<seq>`, seq is a positive integer.  We allow runIds that
// contain dashes themselves (uuidv4/uuidv7 do), so the format check only
// asserts: must end with `-<positive-integer>`.
export const EventIdSchema = z
  .string()
  .regex(/^.+-[1-9]\d*$/, 'eventId must be <runId>-<seq> with positive integer seq');

const EnvelopeBase = {
  eventId: EventIdSchema,
  runId: z.string().min(1),
  timestamp: z.number().int().positive(),
  schemaVersion: z.literal(1),
  actor: ActorEnum,
  payloadHash: z.string().regex(Sha256Pattern).optional(),
};

/**
 * Build a single event schema by wrapping the envelope around a literal
 * `type` and the type's payload schema.  The payload can be inline (the
 * payload zod object) OR a ref to a blob file when it exceeds the inline
 * size cap (see INLINE_PAYLOAD_MAX_BYTES below).
 */
function event<T extends z.ZodTypeAny>(typeLiteral: string, payloadSchema: T) {
  return z.object({
    ...EnvelopeBase,
    type: z.literal(typeLiteral),
    payload: z.union([payloadSchema, PayloadRefSchema]),
  });
}

// ─── The 31 event schemas ───────────────────────────────────────────────────

// Group 1 — Lifecycle (14)
export const RunCreatedEventSchema = event('runCreated', RunCreatedPayload);
export const RunStartedEventSchema = event('runStarted', RunStartedPayload);
export const RunSucceededEventSchema = event('runSucceeded', RunSucceededPayload);
export const RunFailedEventSchema = event('runFailed', RunFailedPayload);
export const RunCanceledEventSchema = event('runCanceled', RunCanceledPayload);
export const NodeWaitingEventSchema = event('nodeWaiting', NodeWaitingPayload);
export const NodeRetryingEventSchema = event('nodeRetrying', NodeRetryingPayload);
export const NodeSucceededEventSchema = event('nodeSucceeded', NodeSucceededPayload);
export const NodeFailedEventSchema = event('nodeFailed', NodeFailedPayload);
export const NodeSkippedEventSchema = event('nodeSkipped', NodeSkippedPayload);
export const NodeCanceledEventSchema = event('nodeCanceled', NodeCanceledPayload);
export const ActivityRunningEventSchema = event('activityRunning', ActivityRunningPayload);
export const ActivityWaitingEventSchema = event('activityWaiting', ActivityWaitingPayload);
export const ActivityTimedOutEventSchema = event('activityTimedOut', ActivityTimedOutPayload);

// Group 2 — Scheduling (5)
export const ConditionEvaluatedEventSchema = event('conditionEvaluated', ConditionEvaluatedPayload);
export const LeaseSignedEventSchema = event('leaseSigned', LeaseSignedPayload);
export const AttemptCreatedEventSchema = event('attemptCreated', AttemptCreatedPayload);
export const BackoffScheduledEventSchema = event('backoffScheduled', BackoffScheduledPayload);
export const BackoffElapsedEventSchema = event('backoffElapsed', BackoffElapsedPayload);

// Group 3 — Side Effect (3)
export const EffectAttemptedEventSchema = event('effectAttempted', EffectAttemptedPayload);
export const ActivitySucceededEventSchema = event('activitySucceeded', ActivitySucceededPayload);
export const ActivityFailedEventSchema = event('activityFailed', ActivityFailedPayload);

// Group 4 — Wait / Human (3)
export const WaitCreatedEventSchema = event('waitCreated', WaitCreatedPayload);
export const WaitResolvedEventSchema = event('waitResolved', WaitResolvedPayload);
export const WaitDeadlineExceededEventSchema = event(
  'waitDeadlineExceeded',
  WaitDeadlineExceededPayload,
);

// Group 5 — Control (3)
export const CancelRequestedEventSchema = event('cancelRequested', CancelRequestedPayload);
export const CancelDeliveredEventSchema = event('cancelDelivered', CancelDeliveredPayload);
export const ActivityCanceledEventSchema = event('activityCanceled', ActivityCanceledPayload);

// Group 6 — System / Recovery (3)
export const WorkerLostEventSchema = event('workerLost', WorkerLostPayload);
export const ResumeStartedEventSchema = event('resumeStarted', ResumeStartedPayload);
export const ReconcileResultEventSchema = event('reconcileResult', ReconcileResultPayload);

// ─── Discriminated union over all 31 ────────────────────────────────────────

const EVENT_SCHEMAS = [
  RunCreatedEventSchema,
  RunStartedEventSchema,
  RunSucceededEventSchema,
  RunFailedEventSchema,
  RunCanceledEventSchema,
  NodeWaitingEventSchema,
  NodeRetryingEventSchema,
  NodeSucceededEventSchema,
  NodeFailedEventSchema,
  NodeSkippedEventSchema,
  NodeCanceledEventSchema,
  ActivityRunningEventSchema,
  ActivityWaitingEventSchema,
  ActivityTimedOutEventSchema,
  ConditionEvaluatedEventSchema,
  LeaseSignedEventSchema,
  AttemptCreatedEventSchema,
  BackoffScheduledEventSchema,
  BackoffElapsedEventSchema,
  EffectAttemptedEventSchema,
  ActivitySucceededEventSchema,
  ActivityFailedEventSchema,
  WaitCreatedEventSchema,
  WaitResolvedEventSchema,
  WaitDeadlineExceededEventSchema,
  CancelRequestedEventSchema,
  CancelDeliveredEventSchema,
  ActivityCanceledEventSchema,
  WorkerLostEventSchema,
  ResumeStartedEventSchema,
  ReconcileResultEventSchema,
] as const;

export const EventSchema = z
  .discriminatedUnion('type', [...EVENT_SCHEMAS])
  // payloadHash invariant: must be present iff payload is ref, absent iff inline.
  // v0.1.2 ratifies this rule (Section 1.1).
  .superRefine((event, ctx) => {
    const isRef = isPayloadRef(event.payload);
    if (isRef && !event.payloadHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'payloadHash required when payload is a ref',
        path: ['payloadHash'],
      });
    }
    if (!isRef && event.payloadHash !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'payloadHash must be absent when payload is inline',
        path: ['payloadHash'],
      });
    }
  });

export type WorkflowEvent = z.infer<typeof EventSchema>;
export type WorkflowEventType = WorkflowEvent['type'];

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Inline payload size cap.  Payloads larger than this must be written as a
 * content-addressed blob and referenced via `PayloadRef`.  v0 value is a
 * pragmatic default; verify and tune after dogfooding (see events doc §6.2).
 */
export const INLINE_PAYLOAD_MAX_BYTES = 4096;

/**
 * Per-provider TTL (ms) within which `idempotentSubmit` is safe.  Used by
 * the reconcile path to decide whether a dangling `effectAttempted` can
 * still be safely retried with the same uuid.  Feishu's documented uuid
 * dedupe window is 1 hour (spike report §1.2).
 */
export const PROVIDER_TTL_MS: Record<string, number> = {
  'feishu-im': 60 * 60 * 1000,
  'botmux-schedule': Number.MAX_SAFE_INTEGER, // schedule entry id is permanent
};

// ─── Re-export Sha256Schema for callers ─────────────────────────────────────

export { Sha256Schema };
