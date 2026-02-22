import type { CoreCommand, CoreGitStatusSnapshot, CoreProjectView } from "@t3tools/contracts";

import type { AppendEventInput } from "./eventStore";

export interface CommandHandlerContext {
  readonly actor: string;
  readonly nowIso: string;
  readonly probeGitStatus: (cwd: string) => Promise<CoreGitStatusSnapshot>;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function baseEvent(input: {
  eventId: string;
  streamId: string;
  aggregateType: "project" | "thread" | "git";
  occurredAt: string;
  causationId: string;
  correlationId: string;
  actor: string;
  eventType: string;
  payload: unknown;
  idempotencyKey?: string | undefined;
}): AppendEventInput {
  return {
    eventId: input.eventId,
    streamId: input.streamId,
    aggregateType: input.aggregateType,
    occurredAt: input.occurredAt,
    causationId: input.causationId,
    correlationId: input.correlationId,
    actor: input.actor,
    eventType: input.eventType,
    payloadJson: json(input.payload),
    idempotencyKey: input.idempotencyKey,
  };
}

function newEventId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function handleCoreCommand(
  command: CoreCommand,
  context: CommandHandlerContext,
): Promise<AppendEventInput[]> {
  const events: AppendEventInput[] = [];
  const occurredAt = context.nowIso;
  const causationId = command.commandId;
  const correlationId = command.commandId;

  switch (command.kind) {
    case "CreateProject": {
      const project: CoreProjectView = {
        id: command.payload.id,
        name: command.payload.name,
        cwd: command.payload.cwd,
        model: command.payload.model,
        expanded: true,
        scripts: [],
      };
      events.push(
        baseEvent({
          eventId: newEventId("project_created"),
          streamId: command.payload.id,
          aggregateType: "project",
          occurredAt,
          causationId,
          correlationId,
          actor: context.actor,
          eventType: "ProjectCreated",
          payload: project,
        }),
      );
      return events;
    }
    case "CreateThread": {
      events.push(
        baseEvent({
          eventId: newEventId("thread_created"),
          streamId: command.payload.id,
          aggregateType: "thread",
          occurredAt,
          causationId,
          correlationId,
          actor: context.actor,
          eventType: "ThreadCreated",
          payload: command.payload,
        }),
      );
      return events;
    }
    case "AppendUserMessage": {
      events.push(
        baseEvent({
          eventId: newEventId("message_user"),
          streamId: command.payload.threadId,
          aggregateType: "thread",
          occurredAt,
          causationId,
          correlationId,
          actor: context.actor,
          eventType: "UserMessageAppended",
          payload: command.payload,
          idempotencyKey: command.commandId,
        }),
      );
      return events;
    }
    case "AppendAssistantMessage": {
      events.push(
        baseEvent({
          eventId: newEventId("message_assistant"),
          streamId: command.payload.threadId,
          aggregateType: "thread",
          occurredAt,
          causationId,
          correlationId,
          actor: context.actor,
          eventType: "AssistantMessageAppended",
          payload: command.payload,
          idempotencyKey: command.commandId,
        }),
      );
      return events;
    }
    case "SetThreadBranch": {
      events.push(
        baseEvent({
          eventId: newEventId("thread_branch"),
          streamId: command.payload.threadId,
          aggregateType: "thread",
          occurredAt,
          causationId,
          correlationId,
          actor: context.actor,
          eventType: "ThreadBranchSet",
          payload: command.payload,
        }),
      );
      return events;
    }
    case "GitWorkflow": {
      events.push(
        baseEvent({
          eventId: newEventId("git_workflow"),
          streamId: command.payload.cwd,
          aggregateType: "git",
          occurredAt,
          causationId,
          correlationId,
          actor: context.actor,
          eventType: "GitWorkflowRecorded",
          payload: command.payload,
        }),
      );
      const status = await context.probeGitStatus(command.payload.cwd);
      events.push(
        baseEvent({
          eventId: newEventId("git_observed"),
          streamId: command.payload.cwd,
          aggregateType: "git",
          occurredAt,
          causationId,
          correlationId,
          actor: context.actor,
          eventType: "GitStateObserved",
          payload: status,
        }),
      );
      return events;
    }
    case "GitProbe": {
      const status = await context.probeGitStatus(command.payload.cwd);
      events.push(
        baseEvent({
          eventId: newEventId("git_observed"),
          streamId: command.payload.cwd,
          aggregateType: "git",
          occurredAt,
          causationId,
          correlationId,
          actor: context.actor,
          eventType: "GitStateObserved",
          payload: status,
        }),
      );
      return events;
    }
    default:
      return events;
  }
}
