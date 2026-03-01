import {
  type AssistantDeliveryMode,
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type ProviderApprovalPolicy,
  type ProviderSandboxMode,
  ProviderThreadId,
  type ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
} from "@t3tools/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, Queue, Ref, Stream } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";

const providerTurnKey = (sessionId: ProviderSessionId, turnId: TurnId) => `${sessionId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

const DEFAULT_ASSISTANT_DELIVERY_MODE: AssistantDeliveryMode = "buffered";
const DEFAULT_APPROVAL_POLICY: ProviderApprovalPolicy = "on-request";
const DEFAULT_SANDBOX_MODE: ProviderSandboxMode = "workspace-write";
const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

function toTurnId(value: string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(value);
}

function toProviderThreadId(value: string | undefined): ProviderThreadId | null {
  return value === undefined ? null : ProviderThreadId.makeUnsafe(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function isSyntheticClaudeThreadId(
  provider: ProviderRuntimeEvent["provider"],
  threadId: ProviderThreadId | null,
): boolean {
  return provider === "claudeCode" && threadId !== null && threadId.startsWith("claude-thread-");
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function eventPayloadRecord(event: ProviderRuntimeEvent): Record<string, unknown> | undefined {
  const rawEvent = event as unknown as Record<string, unknown>;
  return asObject(rawEvent.payload);
}

function mapLegacyTurnStatusToState(
  status: unknown,
): "completed" | "failed" | "cancelled" | "interrupted" | undefined {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return status;
    default:
      return undefined;
  }
}

function getTurnCompletionState(event: ProviderRuntimeEvent):
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | undefined {
  if (event.type !== "turn.completed") {
    return undefined;
  }
  const payload = eventPayloadRecord(event);
  const stateFromPayload = mapLegacyTurnStatusToState(payload?.state);
  if (stateFromPayload !== undefined) {
    return stateFromPayload;
  }
  const rawEvent = event as unknown as Record<string, unknown>;
  return mapLegacyTurnStatusToState(rawEvent.status);
}

function getTurnCompletionErrorMessage(event: ProviderRuntimeEvent): string | undefined {
  if (event.type !== "turn.completed") {
    return undefined;
  }
  const payload = eventPayloadRecord(event);
  const payloadMessage = asString(payload?.errorMessage);
  if (payloadMessage !== undefined) {
    return payloadMessage;
  }
  const rawEvent = event as unknown as Record<string, unknown>;
  return asString(rawEvent.errorMessage);
}

function getRuntimeErrorMessage(event: ProviderRuntimeEvent): string {
  if (event.type !== "runtime.error") {
    return "Runtime error";
  }
  const payload = eventPayloadRecord(event);
  const payloadMessage = asString(payload?.message);
  if (payloadMessage !== undefined && payloadMessage.length > 0) {
    return payloadMessage;
  }
  const rawEvent = event as unknown as Record<string, unknown>;
  const legacyMessage = asString(rawEvent.message);
  if (legacyMessage !== undefined && legacyMessage.length > 0) {
    return legacyMessage;
  }
  return "Runtime error";
}

function mapLegacyRequestType(value: unknown):
  | "command_execution_approval"
  | "file_change_approval"
  | "apply_patch_approval"
  | "exec_command_approval"
  | "tool_user_input"
  | "dynamic_tool_call"
  | "auth_tokens_refresh"
  | "unknown" {
  switch (value) {
    case "command_execution_approval":
    case "file_change_approval":
    case "apply_patch_approval":
    case "exec_command_approval":
    case "tool_user_input":
    case "dynamic_tool_call":
    case "auth_tokens_refresh":
      return value;
    case "command":
      return "command_execution_approval";
    case "file-change":
      return "file_change_approval";
    case "apply_patch":
      return "apply_patch_approval";
    case "exec_command":
      return "exec_command_approval";
    case "user_input":
      return "tool_user_input";
    case "tool":
      return "dynamic_tool_call";
    case "auth":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function mapLegacyToolKindToItemType(
  value: unknown,
): "command_execution" | "file_change" | "apply_patch" | "dynamic_tool_call" {
  switch (value) {
    case "command_execution":
    case "command":
      return "command_execution";
    case "file_change":
    case "file-change":
      return "file_change";
    case "apply_patch":
      return "apply_patch";
    default:
      return "dynamic_tool_call";
  }
}

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = event.sessionSequence !== undefined ? { sequence: event.sessionSequence } : {};
  const rawEvent = event as unknown as Record<string, unknown>;
  const rawEventType = asString(rawEvent.type);
  switch (event.type) {
    case "request.opened": {
      const isCommandLike =
        event.payload.requestType === "command_execution_approval" ||
        event.payload.requestType === "exec_command_approval";
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            isCommandLike
              ? "Command approval requested"
              : event.payload.requestType === "file_change_approval" ||
                  event.payload.requestType === "apply_patch_approval"
                ? "File-change approval requested"
                : "Approval requested",
          payload: {
            requestId: event.requestId,
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: event.requestId,
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(getRuntimeErrorMessage(event)),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (event.payload.itemType === "assistant_message") {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: `${event.payload.title ?? "Tool"} complete`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (event.payload.itemType === "assistant_message") {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  if (rawEventType === "approval.requested") {
    const requestType = mapLegacyRequestType(rawEvent.requestType ?? rawEvent.requestKind);
    const detail = asString(rawEvent.detail);
    const requestId = asString(rawEvent.requestId);
    return [
      {
        id: event.eventId,
        createdAt: event.createdAt,
        tone: "approval",
        kind: "approval.requested",
        summary:
          requestType === "command_execution_approval" || requestType === "exec_command_approval"
            ? "Command approval requested"
            : requestType === "file_change_approval" || requestType === "apply_patch_approval"
              ? "File-change approval requested"
              : "Approval requested",
        payload: {
          ...(requestId ? { requestId } : {}),
          requestType,
          ...(detail ? { detail: truncateDetail(detail) } : {}),
        },
        turnId: toTurnId(asString(rawEvent.turnId)) ?? null,
        ...maybeSequence,
      },
    ];
  }

  if (rawEventType === "approval.resolved") {
    const requestType = mapLegacyRequestType(rawEvent.requestType ?? rawEvent.requestKind);
    const requestId = asString(rawEvent.requestId);
    const decision = asString(rawEvent.decision);
    return [
      {
        id: event.eventId,
        createdAt: event.createdAt,
        tone: "approval",
        kind: "approval.resolved",
        summary: "Approval resolved",
        payload: {
          ...(requestId ? { requestId } : {}),
          requestType,
          ...(decision ? { decision } : {}),
        },
        turnId: toTurnId(asString(rawEvent.turnId)) ?? null,
        ...maybeSequence,
      },
    ];
  }

  if (rawEventType === "tool.started" || rawEventType === "tool.completed") {
    const itemType = mapLegacyToolKindToItemType(rawEvent.toolKind);
    const title = asString(rawEvent.title) ?? "Tool";
    const detail = asString(rawEvent.detail);
    return [
      {
        id: event.eventId,
        createdAt: event.createdAt,
        tone: "tool",
        kind: rawEventType === "tool.started" ? "tool.started" : "tool.completed",
        summary: `${title} ${rawEventType === "tool.started" ? "started" : "complete"}`,
        payload: {
          itemType,
          ...(detail ? { detail: truncateDetail(detail) } : {}),
        },
        turnId: toTurnId(asString(rawEvent.turnId)) ?? null,
        ...maybeSequence,
      },
    ];
  }

  return [];
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;

  const assistantDeliveryModeRef = yield* Ref.make<AssistantDeliveryMode>(
    DEFAULT_ASSISTANT_DELIVERY_MODE,
  );

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const rememberAssistantMessageId = (
    sessionId: ProviderSessionId,
    turnId: TurnId,
    messageId: MessageId,
  ) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(sessionId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(sessionId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (
    sessionId: ProviderSessionId,
    turnId: TurnId,
    messageId: MessageId,
  ) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(sessionId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(sessionId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(sessionId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (sessionId: ProviderSessionId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(sessionId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (sessionId: ProviderSessionId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(sessionId, turnId));

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
  }) =>
    Effect.gen(function* () {
      const text = yield* takeBufferedAssistantText(input.messageId);

      if (text.length > 0) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(input.event, input.finalDeltaCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      yield* clearAssistantMessageState(input.messageId);
    });

  const clearTurnStateForSession = (sessionId: ProviderSessionId) =>
    Effect.gen(function* () {
      const prefix = `${sessionId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const rawEvent = event as unknown as Record<string, unknown>;
      const rawEventType = asString(rawEvent.type) ?? event.type;
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find(
        (entry) => entry.session?.providerSessionId === event.sessionId,
      );
      if (!thread) return;

      const now = event.createdAt;
      const sessionProviderThreadId = thread.session?.providerThreadId ?? null;
      const scopedSessionProviderThreadId = isSyntheticClaudeThreadId(
        event.provider,
        sessionProviderThreadId,
      )
        ? null
        : sessionProviderThreadId;
      const eventProviderThreadId = toProviderThreadId(event.threadId);
      const eventTurnId = toTurnId("turnId" in event ? event.turnId : undefined);
      const activeTurnId = thread.session?.activeTurnId ?? null;

      const matchesThreadScope =
        eventProviderThreadId === null ||
        scopedSessionProviderThreadId === null ||
        sameId(eventProviderThreadId, scopedSessionProviderThreadId);
      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            if (!matchesThreadScope) {
              return false;
            }
            // Never let auxiliary/provider-side spawned threads replace the primary thread binding.
            if (
              eventProviderThreadId !== null &&
              scopedSessionProviderThreadId !== null &&
              !sameId(eventProviderThreadId, scopedSessionProviderThreadId)
            ) {
              return false;
            }
            return true;
          case "turn.started":
            if (!matchesThreadScope) {
              return false;
            }
            return !conflictsWithActiveTurn;
          case "turn.completed":
            if (!matchesThreadScope) {
              return false;
            }
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();

      if (
        event.type === "session.started" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const turnCompletionState = getTurnCompletionState(event);
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" || event.type === "session.exited"
              ? null
              : activeTurnId;
        const providerThreadIdFromEvent =
          event.type === "thread.started"
            ? (event.threadId ? ProviderThreadId.makeUnsafe(event.threadId) : null)
            : event.threadId !== undefined
              ? ProviderThreadId.makeUnsafe(event.threadId)
              : null;
        const providerThreadId =
          providerThreadIdFromEvent ?? scopedSessionProviderThreadId ?? null;
        const status = (() => {
          switch (event.type) {
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return turnCompletionState === "failed" ? "error" : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        const lastError =
          event.type === "turn.completed" && turnCompletionState === "failed"
            ? (getTurnCompletionErrorMessage(event) ?? thread.session?.lastError ?? "Turn failed")
            : status === "ready"
              ? null
              : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              providerSessionId: event.sessionId,
              providerThreadId,
              approvalPolicy: thread.session?.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
              sandboxMode: thread.session?.sandboxMode ?? DEFAULT_SANDBOX_MODE,
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      const isV2AssistantTextDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text";
      const isLegacyAssistantTextDelta = rawEventType === "message.delta";
      if (isV2AssistantTextDelta || isLegacyAssistantTextDelta) {
        const delta = (
          event.type === "content.delta"
            ? event.payload.delta
            : ((rawEvent.delta as string | undefined) as string)
        ).toString();
        if (delta.length === 0) {
          return;
        }

        const assistantMessageId = MessageId.makeUnsafe(
          `assistant:${event.itemId ?? event.turnId ?? event.sessionId}`,
        );
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* rememberAssistantMessageId(event.sessionId, turnId, assistantMessageId);
        }

        const assistantDeliveryMode = yield* Ref.get(assistantDeliveryModeRef);
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(
            assistantMessageId,
            delta,
          );
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      const isAssistantMessageCompleted =
        (event.type === "item.completed" && event.payload.itemType === "assistant_message") ||
        rawEventType === "message.completed";
      if (isAssistantMessageCompleted) {
        const assistantMessageId = MessageId.makeUnsafe(
          `assistant:${event.itemId ?? asString(rawEvent.itemId) ?? event.turnId ?? event.sessionId}`,
        );
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* rememberAssistantMessageId(event.sessionId, turnId, assistantMessageId);
        }

        yield* finalizeAssistantMessage({
          event,
          threadId: thread.id,
          messageId: assistantMessageId,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
          commandTag: "assistant-complete",
          finalDeltaCommandTag: "assistant-delta-finalize",
        });

        if (turnId) {
          yield* forgetAssistantMessageId(event.sessionId, turnId, assistantMessageId);
        }
      }

      if (event.type === "turn.completed") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(event.sessionId, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(event.sessionId, turnId);
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(event.sessionId);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = getRuntimeErrorMessage(event);
        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : matchesThreadScope &&
            (activeTurnId === null ||
              eventTurnId === undefined ||
              sameId(activeTurnId, eventTurnId));

        const providerThreadId =
          event.threadId !== undefined
            ? ProviderThreadId.makeUnsafe(event.threadId)
            : (thread.session?.providerThreadId ?? null);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              providerSessionId: event.sessionId,
              providerThreadId,
              approvalPolicy: thread.session?.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
              sandboxMode: thread.session?.sandboxMode ?? DEFAULT_SANDBOX_MODE,
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      const activities = runtimeEventToActivities(event);
      yield* Effect.forEach(activities, (activity) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(event, "thread-activity-append"),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        }),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (event: TurnStartRequestedDomainEvent) =>
    Ref.set(
      assistantDeliveryModeRef,
      event.payload.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
    );

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const start: ProviderRuntimeIngestionShape["start"] = Effect.gen(function* () {
    const inputQueue = yield* Queue.unbounded<RuntimeIngestionInput>();
    yield* Effect.addFinalizer(() => Queue.shutdown(inputQueue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(
      Effect.forever(Queue.take(inputQueue).pipe(Effect.flatMap(processInputSafely))),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        Queue.offer(inputQueue, { source: "runtime", event }).pipe(Effect.asVoid),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return Queue.offer(inputQueue, { source: "domain", event }).pipe(Effect.asVoid);
      }),
    );
  });

  return {
    start,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(ProviderRuntimeIngestionService, make);
