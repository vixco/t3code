import { Schema } from "effect";

export const RuntimeModeSchema = Schema.Literal("approval-required", "full-access");
export type RuntimeMode = Schema.Schema.Type<typeof RuntimeModeSchema>;

export const ProjectScriptSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  command: Schema.String,
  keybinding: Schema.optional(Schema.String),
});
export type ProjectScript = Schema.Schema.Type<typeof ProjectScriptSchema>;

export const ProjectViewSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  cwd: Schema.String,
  model: Schema.String,
  expanded: Schema.Boolean,
  scripts: Schema.Array(ProjectScriptSchema),
});
export type ProjectView = Schema.Schema.Type<typeof ProjectViewSchema>;

export const ChatAttachmentSchema = Schema.Struct({
  type: Schema.Literal("image"),
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  previewUrl: Schema.optional(Schema.String),
});
export type ChatAttachment = Schema.Schema.Type<typeof ChatAttachmentSchema>;

export const ChatMessageSchema = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("user", "assistant"),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachmentSchema)),
  createdAt: Schema.String,
  streaming: Schema.Boolean,
});
export type ChatMessage = Schema.Schema.Type<typeof ChatMessageSchema>;

export const SessionStatusSchema = Schema.Literal(
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
);
export type SessionStatus = Schema.Schema.Type<typeof SessionStatusSchema>;

export const ProviderSessionViewSchema = Schema.Struct({
  sessionId: Schema.String,
  provider: Schema.Literal("codex", "claudeCode"),
  status: SessionStatusSchema,
  cwd: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  activeTurnId: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastError: Schema.optional(Schema.String),
});
export type ProviderSessionView = Schema.Schema.Type<typeof ProviderSessionViewSchema>;

export const ProviderEventSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("session", "notification", "request", "error"),
  method: Schema.String,
  payload: Schema.optional(Schema.Unknown),
  createdAt: Schema.String,
  sessionId: Schema.String,
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  itemId: Schema.optional(Schema.String),
  textDelta: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  requestKind: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type ProviderEvent = Schema.Schema.Type<typeof ProviderEventSchema>;

export const TurnDiffFileChangeSchema = Schema.Struct({
  path: Schema.String,
  kind: Schema.optional(Schema.String),
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
});
export type TurnDiffFileChange = Schema.Schema.Type<typeof TurnDiffFileChangeSchema>;

export const TurnDiffSummarySchema = Schema.Struct({
  turnId: Schema.String,
  completedAt: Schema.String,
  status: Schema.optional(Schema.String),
  files: Schema.Array(TurnDiffFileChangeSchema),
  assistantMessageId: Schema.optional(Schema.String),
  checkpointTurnCount: Schema.optional(Schema.Number),
});
export type TurnDiffSummary = Schema.Schema.Type<typeof TurnDiffSummarySchema>;

export const ThreadTerminalGroupSchema = Schema.Struct({
  id: Schema.String,
  terminalIds: Schema.Array(Schema.String),
});
export type ThreadTerminalGroup = Schema.Schema.Type<typeof ThreadTerminalGroupSchema>;

export const ThreadViewSchema = Schema.Struct({
  id: Schema.String,
  codexThreadId: Schema.NullOr(Schema.String),
  projectId: Schema.String,
  title: Schema.String,
  model: Schema.String,
  terminalOpen: Schema.Boolean,
  terminalHeight: Schema.Number,
  terminalIds: Schema.Array(Schema.String),
  runningTerminalIds: Schema.Array(Schema.String),
  activeTerminalId: Schema.String,
  terminalGroups: Schema.Array(ThreadTerminalGroupSchema),
  activeTerminalGroupId: Schema.String,
  session: Schema.NullOr(ProviderSessionViewSchema),
  messages: Schema.Array(ChatMessageSchema),
  events: Schema.Array(ProviderEventSchema),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  latestTurnId: Schema.optional(Schema.String),
  latestTurnStartedAt: Schema.optional(Schema.String),
  latestTurnCompletedAt: Schema.optional(Schema.String),
  latestTurnDurationMs: Schema.optional(Schema.Number),
  lastVisitedAt: Schema.optional(Schema.String),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  turnDiffSummaries: Schema.Array(TurnDiffSummarySchema),
});
export type ThreadView = Schema.Schema.Type<typeof ThreadViewSchema>;

export const AppViewStateSchema = Schema.Struct({
  projects: Schema.Array(ProjectViewSchema),
  threads: Schema.Array(ThreadViewSchema),
  threadsHydrated: Schema.Boolean,
  runtimeMode: RuntimeModeSchema,
  lastPosition: Schema.Number,
});
export type AppViewState = Schema.Schema.Type<typeof AppViewStateSchema>;

export const emptyAppViewState = (): AppViewState => ({
  projects: [],
  threads: [],
  threadsHydrated: false,
  runtimeMode: "full-access",
  lastPosition: 0,
});
