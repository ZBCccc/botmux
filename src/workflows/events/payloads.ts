import { z } from 'zod';

// ─── Shared primitives ──────────────────────────────────────────────────────

export const Sha256Pattern = /^sha256:[0-9a-f]{64}$/;
export const Sha256Schema = z.string().regex(Sha256Pattern, 'must be sha256:<64-hex>');

export const ActorEnum = z.enum([
  'scheduler',
  'worker',
  'hostExecutor',
  'human',
  'supervisor',
  'system',
]);
export type Actor = z.infer<typeof ActorEnum>;

export const ErrorClassEnum = z.enum(['retryable', 'fatal', 'userFault', 'manual']);
export type ErrorClass = z.infer<typeof ErrorClassEnum>;

export const ErrorCodeEnum = z.enum([
  'LeaseExpired',
  'WorkerCrashed',
  'NetworkError',
  'ProviderRateLimited',
  'IdempotencyInputMismatch',
  'IdempotencyConflict',
  'InputValidationFailed',
  'OutputSchemaViolation',
  'WaitDeadlineExceeded',
  'TtlExpired',
  'UnknownProviderError',
]);
export type ErrorCode = z.infer<typeof ErrorCodeEnum>;

export const ErrorPayloadSchema = z.object({
  errorCode: ErrorCodeEnum,
  errorClass: ErrorClassEnum,
  errorMessage: z.string().max(4096),
  stackRef: z.string().optional(),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

export const OutputRefSchema = z.object({
  outputHash: Sha256Schema,
  outputPath: z.string().optional(),
  outputBytes: z.number().int().nonnegative(),
  outputSchemaVersion: z.number().int().positive(),
  contentType: z.string().optional(),
});
export type OutputRef = z.infer<typeof OutputRefSchema>;

export const ReconcileCapabilityEnum = z.enum(['readOnlyLookup', 'idempotentSubmit', 'none']);
export const ReconcileDecisionEnum = z.enum([
  'replayed',
  'completedByIdempotentSubmit',
  'manual',
  'freshRetry',
]);

export const WaitKindEnum = z.enum(['human-gate', 'time', 'condition']);
export const WaitResolutionEnum = z.enum(['approved', 'rejected', 'external']);

export const CancelTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), runId: z.string() }),
  z.object({ kind: z.literal('node'), nodeId: z.string() }),
  z.object({ kind: z.literal('activity'), activityId: z.string() }),
]);

export const BackoffPolicySchema = z.object({
  kind: z.enum(['fixed', 'exponential']),
  baseMs: z.number().int().positive(),
  factor: z.number().positive().optional(),
  jitter: z.boolean().optional(),
});

// ─── Group 1 — Lifecycle (14) ───────────────────────────────────────────────

export const RunCreatedPayload = z.object({
  workflowId: z.string(),
  revisionId: z.string(),
  inputRef: OutputRefSchema,
  initiator: z.string(),
});

export const RunStartedPayload = z.object({}).strict();

export const RunSucceededPayload = z.object({
  outputRef: OutputRefSchema,
});

export const RunFailedPayload = z.object({
  failedNodeId: z.string(),
  rootCauseEventId: z.string(),
});

export const RunCanceledPayload = z.object({
  cancelOriginEventId: z.string(),
});

export const NodeWaitingPayload = z.object({
  nodeId: z.string(),
  waitReason: z.string(),
  deadlineAt: z.number().int().positive().optional(),
});

export const NodeRetryingPayload = z.object({
  nodeId: z.string(),
  lastAttemptId: z.string(),
  nextBackoffMs: z.number().int().nonnegative(),
});

export const NodeSucceededPayload = z.object({
  nodeId: z.string(),
  lastActivityId: z.string(),
});

export const NodeFailedPayload = z.object({
  nodeId: z.string(),
  lastActivityId: z.string(),
  errorClass: ErrorClassEnum,
});

export const NodeSkippedPayload = z.object({
  nodeId: z.string(),
  conditionEventId: z.string(),
});

export const NodeCanceledPayload = z.object({
  nodeId: z.string(),
  cancelOriginEventId: z.string(),
});

export const ActivityRunningPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  leaseId: z.string(),
});

export const ActivityWaitingPayload = z.object({
  activityId: z.string(),
  reason: z.string(),
});

export const ActivityTimedOutPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  runningMs: z.number().int().nonnegative(),
  reason: z.literal('LeaseExpired'),
  errorClass: z.literal('retryable'),
});

// ─── Group 2 — Scheduling (5) ───────────────────────────────────────────────

export const ConditionEvaluatedPayload = z.object({
  nodeId: z.string(),
  conditionExpr: z.string(),
  resultTrue: z.boolean(),
  evaluatedInputs: z.record(z.unknown()).optional(),
});

export const LeaseSignedPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  leaseId: z.string(),
  timeoutMs: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
});

export const AttemptCreatedPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  attemptNumber: z.number().int().positive(),
  inputRef: OutputRefSchema,
});

export const BackoffScheduledPayload = z.object({
  nodeId: z.string(),
  lastAttemptId: z.string(),
  nextAttemptAt: z.number().int().positive(),
  backoffPolicy: BackoffPolicySchema,
});

export const BackoffElapsedPayload = z.object({
  nodeId: z.string(),
  scheduledAttemptId: z.string(),
});

// ─── Group 3 — Side Effect (3) ──────────────────────────────────────────────

export const EffectAttemptedPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  // idempotencyKey is the 50-char-bounded provider uuid derived from
  // hash(workflowId:revisionId:runId:nodeId:attemptId). Feishu uuid field
  // accepts ≤ 50 chars; spike report Section 1.6.
  idempotencyKey: z.string().min(1).max(50),
  inputHash: Sha256Schema,
  idempotencyTtlMs: z.number().int().positive(),
  provider: z.string(),
});

export const ActivitySucceededPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  outputRef: OutputRefSchema,
  // type-specific external refs returned by provider on side-effecting
  // succeeded events: send/reply → { messageId }, schedule → { taskId },
  // pure skills omit. v0 keeps the shape open; v0.x+ standardizes per provider.
  externalRefs: z.record(z.unknown()).optional(),
});

export const ActivityFailedPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  error: ErrorPayloadSchema,
});

// ─── Group 4 — Wait / Human (3) ─────────────────────────────────────────────

export const WaitCreatedPayload = z.object({
  activityId: z.string(),
  nodeId: z.string(),
  waitKind: WaitKindEnum,
  deadlineAt: z.number().int().positive().optional(),
  prompt: z.string().optional(),
});

export const WaitResolvedPayload = z.object({
  activityId: z.string(),
  resolution: WaitResolutionEnum,
  by: z.string(),
  comment: z.string().optional(),
});

export const WaitDeadlineExceededPayload = z.object({
  activityId: z.string(),
  deadlineAt: z.number().int().positive(),
  exceededAtMs: z.number().int().positive(),
});

// ─── Group 5 — Control (3) ──────────────────────────────────────────────────

export const CancelRequestedPayload = z.object({
  target: CancelTargetSchema,
  reason: z.string(),
  by: z.string(),
});

export const CancelDeliveredPayload = z.object({
  target: CancelTargetSchema,
  activityId: z.string(),
});

export const ActivityCanceledPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  cancelOriginEventId: z.string(),
});

// ─── Group 6 — System / Recovery (3) ────────────────────────────────────────

export const WorkerLostPayload = z.object({
  workerId: z.string(),
  lostActivityIds: z.array(z.string()).min(1),
});

export const ResumeStartedPayload = z.object({
  daemonId: z.string(),
  lastSeenEventId: z.string(),
});

export const ReconcileResultPayload = z.object({
  activityId: z.string(),
  idempotencyKey: z.string().min(1).max(50),
  capability: ReconcileCapabilityEnum,
  decision: ReconcileDecisionEnum,
  evidence: z.record(z.unknown()),
});
