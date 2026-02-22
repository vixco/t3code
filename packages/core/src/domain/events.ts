import { Schema } from "effect";

import {
  type AppViewState,
  ProjectScriptSchema,
  ProviderEventSchema,
  ProviderSessionViewSchema,
  RuntimeModeSchema,
} from "./models";

export const DomainEventTypeSchema = Schema.Literal(
  "app.bootstrapped",
  "project.added",
  "project.removed",
  "project.scriptsUpdated",
  "thread.created",
  "thread.deleted",
  "thread.userMessageAdded",
  "thread.providerSessionUpdated",
  "thread.providerEventRecorded",
  "thread.branchSet",
  "thread.terminalActivitySet",
  "thread.markVisited",
  "runtime.modeSet",
);
export type DomainEventType = Schema.Schema.Type<typeof DomainEventTypeSchema>;

const AppBootstrappedPayloadSchema = Schema.Struct({
  cwd: Schema.String,
  projectName: Schema.String,
});

const ProjectAddedPayloadSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  cwd: Schema.String,
  model: Schema.String,
  scripts: Schema.Array(ProjectScriptSchema),
});

const ProjectRemovedPayloadSchema = Schema.Struct({ id: Schema.String });

const ProjectScriptsUpdatedPayloadSchema = Schema.Struct({
  id: Schema.String,
  scripts: Schema.Array(ProjectScriptSchema),
});

const ThreadCreatedPayloadSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  model: Schema.String,
  createdAt: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
});

const ThreadDeletedPayloadSchema = Schema.Struct({ id: Schema.String });

const ThreadUserMessageAddedPayloadSchema = Schema.Struct({
  threadId: Schema.String,
  messageId: Schema.String,
  text: Schema.String,
  createdAt: Schema.String,
  attachments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literal("image"),
        id: Schema.String,
        name: Schema.String,
        mimeType: Schema.String,
        sizeBytes: Schema.Number,
        previewUrl: Schema.optional(Schema.String),
      }),
    ),
  ),
});

const ThreadProviderSessionUpdatedPayloadSchema = Schema.Struct({
  threadId: Schema.String,
  session: Schema.NullOr(ProviderSessionViewSchema),
});

const ThreadProviderEventRecordedPayloadSchema = Schema.Struct({
  threadId: Schema.String,
  event: ProviderEventSchema,
});

const ThreadBranchSetPayloadSchema = Schema.Struct({
  threadId: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
});

const ThreadTerminalActivitySetPayloadSchema = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.String,
  running: Schema.Boolean,
});

const ThreadMarkVisitedPayloadSchema = Schema.Struct({
  threadId: Schema.String,
  visitedAt: Schema.String,
});

const RuntimeModeSetPayloadSchema = Schema.Struct({
  mode: RuntimeModeSchema,
});

export type DomainEventPayload =
  | Schema.Schema.Type<typeof AppBootstrappedPayloadSchema>
  | Schema.Schema.Type<typeof ProjectAddedPayloadSchema>
  | Schema.Schema.Type<typeof ProjectRemovedPayloadSchema>
  | Schema.Schema.Type<typeof ProjectScriptsUpdatedPayloadSchema>
  | Schema.Schema.Type<typeof ThreadCreatedPayloadSchema>
  | Schema.Schema.Type<typeof ThreadDeletedPayloadSchema>
  | Schema.Schema.Type<typeof ThreadUserMessageAddedPayloadSchema>
  | Schema.Schema.Type<typeof ThreadProviderSessionUpdatedPayloadSchema>
  | Schema.Schema.Type<typeof ThreadProviderEventRecordedPayloadSchema>
  | Schema.Schema.Type<typeof ThreadBranchSetPayloadSchema>
  | Schema.Schema.Type<typeof ThreadTerminalActivitySetPayloadSchema>
  | Schema.Schema.Type<typeof ThreadMarkVisitedPayloadSchema>
  | Schema.Schema.Type<typeof RuntimeModeSetPayloadSchema>;

export interface DomainEventEnvelope {
  readonly eventId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly position: number;
  readonly type: DomainEventType;
  readonly occurredAt: string;
  readonly payload: DomainEventPayload;
  readonly causationId?: string;
  readonly correlationId?: string;
}

export interface NewDomainEvent {
  readonly streamId: string;
  readonly type: DomainEventType;
  readonly payload: DomainEventPayload;
  readonly occurredAt: string;
  readonly causationId?: string;
  readonly correlationId?: string;
}

export interface StateUpdatedNotification {
  readonly state: AppViewState;
  readonly events: readonly DomainEventEnvelope[];
}
