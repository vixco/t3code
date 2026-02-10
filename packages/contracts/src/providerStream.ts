import { z } from "zod";

import { providerKindSchema, providerSessionSchema } from "./provider";

export const providerStreamEventKindSchema = z.enum([
  "session",
  "turn",
  "message",
  "approval",
  "activity",
  "error",
  "debug.raw",
]);

export const canonicalSessionStateSchema = providerSessionSchema;

export const canonicalTurnStateSchema = z.object({
  sessionId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  startedAt: z.string().datetime(),
  model: z.string().min(1).optional(),
});

export const canonicalMessageStateSchema = z.object({
  sessionId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  messageId: z.string().min(1),
  role: z.literal("assistant"),
  text: z.string(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const canonicalApprovalKindSchema = z.enum([
  "command",
  "file_change",
  "user_input",
]);

export const canonicalApprovalStateSchema = z.object({
  sessionId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  approvalId: z.string().min(1),
  approvalKind: canonicalApprovalKindSchema,
  title: z.string().min(1),
  detail: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  timeoutAt: z.string().datetime().optional(),
  requestedAt: z.string().datetime(),
});

export const providerCoreEventExtensionsSchema = z.record(z.string(), z.unknown());

export const sessionUpdatedEventSchema = z.object({
  type: z.literal("session.updated"),
  session: canonicalSessionStateSchema,
  extensions: providerCoreEventExtensionsSchema.optional(),
});

export const turnStartedEventSchema = z.object({
  type: z.literal("turn.started"),
  sessionId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  startedAt: z.string().datetime(),
  model: z.string().min(1).optional(),
  extensions: providerCoreEventExtensionsSchema.optional(),
});

export const turnCompletedOutcomeSchema = z.enum([
  "completed",
  "failed",
  "interrupted",
]);

export const turnCompletedEventSchema = z.object({
  type: z.literal("turn.completed"),
  sessionId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  completedAt: z.string().datetime(),
  outcome: turnCompletedOutcomeSchema,
  error: z.string().min(1).optional(),
  durationMs: z.number().nonnegative().optional(),
  extensions: providerCoreEventExtensionsSchema.optional(),
});

export const messageDeltaEventSchema = z.object({
  type: z.literal("message.delta"),
  sessionId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  messageId: z.string().min(1),
  role: z.literal("assistant"),
  delta: z.string(),
  extensions: providerCoreEventExtensionsSchema.optional(),
});

export const messageCompletedEventSchema = z.object({
  type: z.literal("message.completed"),
  sessionId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  messageId: z.string().min(1),
  role: z.literal("assistant"),
  text: z.string(),
  extensions: providerCoreEventExtensionsSchema.optional(),
});

export const approvalRequestedEventSchema = z.object({
  type: z.literal("approval.requested"),
  sessionId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  approvalId: z.string().min(1),
  approvalKind: canonicalApprovalKindSchema,
  title: z.string().min(1),
  detail: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  timeoutAt: z.string().datetime().optional(),
  requestedAt: z.string().datetime(),
  extensions: providerCoreEventExtensionsSchema.optional(),
});

export const approvalResolvedDecisionSchema = z.enum([
  "accept",
  "accept_for_session",
  "decline",
  "cancel",
  "timed_out",
]);

export const approvalResolvedEventSchema = z.object({
  type: z.literal("approval.resolved"),
  sessionId: z.string().min(1),
  approvalId: z.string().min(1),
  decision: approvalResolvedDecisionSchema,
  resolvedAt: z.string().datetime(),
  reason: z.string().min(1).optional(),
  extensions: providerCoreEventExtensionsSchema.optional(),
});

export const activityKindSchema = z.enum(["tool", "plan", "system"]);

export const activityStatusSchema = z.enum([
  "created",
  "in_progress",
  "success",
  "failed",
  "denied",
  "timed_out",
]);

export const activityEventSchema = z.object({
  type: z.literal("activity"),
  sessionId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  activityId: z.string().min(1),
  activityKind: activityKindSchema,
  label: z.string().min(1),
  detail: z.string().min(1).optional(),
  status: activityStatusSchema,
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  extensions: providerCoreEventExtensionsSchema.optional(),
});

export const errorEventSchema = z.object({
  type: z.literal("error"),
  sessionId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().optional(),
  extensions: providerCoreEventExtensionsSchema.optional(),
});

export const debugRawEventSchema = z.object({
  type: z.literal("debug.raw"),
  provider: providerKindSchema,
  sessionId: z.string().min(1).optional(),
  method: z.string().min(1),
  payload: z.unknown(),
});

export const providerCoreEventSchema = z.discriminatedUnion("type", [
  sessionUpdatedEventSchema,
  turnStartedEventSchema,
  turnCompletedEventSchema,
  messageDeltaEventSchema,
  messageCompletedEventSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  activityEventSchema,
  errorEventSchema,
  debugRawEventSchema,
]);

export const providerSnapshotSchema = z.object({
  sessions: z.array(canonicalSessionStateSchema),
  activeTurns: z.array(canonicalTurnStateSchema),
  activeMessages: z.array(canonicalMessageStateSchema),
  pendingApprovals: z.array(canonicalApprovalStateSchema),
});

export const providerStreamGapReasonSchema = z.enum([
  "cursor_too_old",
  "cursor_ahead",
  "replay_limit_exceeded",
]);

export const providerStreamGapSchema = z.object({
  reason: providerStreamGapReasonSchema,
  oldestSeq: z.number().int().nonnegative(),
  currentSeq: z.number().int().nonnegative(),
});

export const providerStreamFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    seq: z.number().int().nonnegative(),
    at: z.string().datetime(),
    data: providerSnapshotSchema,
  }),
  z.object({
    kind: z.literal("event"),
    seq: z.number().int().nonnegative(),
    at: z.string().datetime(),
    data: providerCoreEventSchema,
  }),
  z.object({
    kind: z.literal("gap"),
    seq: z.number().int().nonnegative(),
    at: z.string().datetime(),
    data: providerStreamGapSchema,
  }),
]);

export const providersOpenStreamInputSchema = z.object({
  afterSeq: z.number().int().nonnegative().optional(),
  sessionIds: z.array(z.string().min(1)).optional(),
  eventKinds: z.array(providerStreamEventKindSchema).optional(),
  includeExtensions: z.array(z.string().min(1)).optional(),
  includeDebugRaw: z.boolean().optional(),
});

export const providersOpenStreamModeSchema = z.enum([
  "snapshot",
  "replay",
  "snapshot_resync",
]);

export const providersOpenStreamResultSchema = z.object({
  mode: providersOpenStreamModeSchema,
  currentSeq: z.number().int().nonnegative(),
  oldestSeq: z.number().int().nonnegative(),
  replayedCount: z.number().int().nonnegative(),
});

export type ProviderStreamEventKind = z.infer<typeof providerStreamEventKindSchema>;
export type CanonicalSessionState = z.infer<typeof canonicalSessionStateSchema>;
export type CanonicalTurnState = z.infer<typeof canonicalTurnStateSchema>;
export type CanonicalMessageState = z.infer<typeof canonicalMessageStateSchema>;
export type CanonicalApprovalKind = z.infer<typeof canonicalApprovalKindSchema>;
export type CanonicalApprovalState = z.infer<typeof canonicalApprovalStateSchema>;
export type ProviderCoreEventExtensions = z.infer<typeof providerCoreEventExtensionsSchema>;
export type SessionUpdatedEvent = z.infer<typeof sessionUpdatedEventSchema>;
export type TurnStartedEvent = z.infer<typeof turnStartedEventSchema>;
export type TurnCompletedOutcome = z.infer<typeof turnCompletedOutcomeSchema>;
export type TurnCompletedEvent = z.infer<typeof turnCompletedEventSchema>;
export type MessageDeltaEvent = z.infer<typeof messageDeltaEventSchema>;
export type MessageCompletedEvent = z.infer<typeof messageCompletedEventSchema>;
export type ApprovalRequestedEvent = z.infer<typeof approvalRequestedEventSchema>;
export type ApprovalResolvedDecision = z.infer<typeof approvalResolvedDecisionSchema>;
export type ApprovalResolvedEvent = z.infer<typeof approvalResolvedEventSchema>;
export type ActivityKind = z.infer<typeof activityKindSchema>;
export type ActivityStatus = z.infer<typeof activityStatusSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
export type DebugRawEvent = z.infer<typeof debugRawEventSchema>;
export type ProviderCoreEvent = z.infer<typeof providerCoreEventSchema>;
export type ProviderSnapshot = z.infer<typeof providerSnapshotSchema>;
export type ProviderStreamGapReason = z.infer<typeof providerStreamGapReasonSchema>;
export type ProviderStreamGap = z.infer<typeof providerStreamGapSchema>;
export type ProviderStreamFrame = z.infer<typeof providerStreamFrameSchema>;
export type ProvidersOpenStreamInput = z.input<typeof providersOpenStreamInputSchema>;
export type ProvidersOpenStreamMode = z.infer<typeof providersOpenStreamModeSchema>;
export type ProvidersOpenStreamResult = z.infer<typeof providersOpenStreamResultSchema>;
