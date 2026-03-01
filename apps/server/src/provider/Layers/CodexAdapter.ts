/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  ProviderItemId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { CodexAppServerManager } from "../../codexAppServerManager.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "codex" as const;

export interface CodexAdapterLiveOptions {
  readonly manager?: CodexAppServerManager;
  readonly makeManager?: () => CodexAppServerManager;
  readonly nativeEventLogPath?: string;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  sessionId: ProviderSessionId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      sessionId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      sessionId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(
  sessionId: ProviderSessionId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(sessionId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstNonEmptyString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toItemType(raw: unknown): CanonicalItemType {
  const normalizedType = normalizeItemType(raw);
  if (normalizedType.includes("assistant message") || normalizedType.includes("agent message")) {
    return "assistant_message";
  }
  if (normalizedType.includes("user message")) {
    return "user_message";
  }
  if (normalizedType.includes("reasoning") || normalizedType.includes("thought")) {
    return "reasoning";
  }
  if (normalizedType.includes("plan")) {
    return "plan";
  }
  if (normalizedType.includes("command")) {
    return "command_execution";
  }
  if (normalizedType.includes("file change") || normalizedType.includes("patch")) {
    return "file_change";
  }
  if (normalizedType.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalizedType.includes("dynamic tool") || normalizedType.includes("tool call")) {
    return "dynamic_tool_call";
  }
  if (normalizedType.includes("collab")) {
    return "collab_agent_tool_call";
  }
  if (normalizedType.includes("web search")) {
    return "web_search";
  }
  if (normalizedType.includes("image")) {
    return "image_view";
  }
  if (normalizedType.includes("review entered")) {
    return "review_entered";
  }
  if (normalizedType.includes("review exited")) {
    return "review_exited";
  }
  if (normalizedType.includes("compact")) {
    return "context_compaction";
  }
  if (normalizedType.includes("error")) {
    return "error";
  }
  return "unknown";
}

function toRequestTypeFromKind(kind: ProviderEvent["requestKind"]): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function toRequestType(method: string, kind: ProviderEvent["requestKind"]): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return toRequestTypeFromKind(kind);
  }
}

function toTurnState(value: unknown): "completed" | "failed" | "interrupted" | "cancelled" | undefined {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    case "interruptedByUser":
      return "interrupted";
    default:
      return undefined;
  }
}

function toThreadState(value: unknown):
  | "active"
  | "idle"
  | "archived"
  | "closed"
  | "compacted"
  | "error"
  | undefined {
  const normalized = asString(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("archiv")) return "archived";
  if (normalized.includes("closed")) return "closed";
  if (normalized.includes("compact")) return "compacted";
  if (normalized.includes("error")) return "error";
  if (normalized.includes("idle")) return "idle";
  if (normalized.includes("active") || normalized.includes("running")) return "active";
  return undefined;
}

function toItemStatus(value: unknown): "inProgress" | "completed" | "failed" | "declined" | undefined {
  switch (value) {
    case "inProgress":
    case "completed":
    case "failed":
    case "declined":
      return value;
    case "in_progress":
      return "inProgress";
    default:
      return undefined;
  }
}

function normalizePlanStatus(value: unknown): "pending" | "inProgress" | "completed" {
  switch (value) {
    case "completed":
      return "completed";
    case "inProgress":
    case "in_progress":
      return "inProgress";
    default:
      return "pending";
  }
}

function eventRawSource(event: ProviderEvent): "codex.app-server.notification" | "codex.app-server.request" {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function mapStatusMethodToSessionState(method: string):
  | "starting"
  | "ready"
  | "running"
  | "waiting"
  | "stopped"
  | "error"
  | undefined {
  switch (method) {
    case "session/connecting":
      return "starting";
    case "session/ready":
      return "ready";
    case "session/running":
      return "running";
    case "session/waiting":
      return "waiting";
    case "session/closed":
      return "stopped";
    case "session/exited":
      return "stopped";
    case "session/startFailed":
      return "error";
    default:
      return undefined;
  }
}

function buildBase(
  event: ProviderEvent,
  overrides?: {
    readonly threadId?: string;
    readonly turnId?: string;
    readonly itemId?: string;
    readonly requestId?: string;
  },
) {
  const threadIdRaw = overrides?.threadId ?? event.threadId;
  const turnIdRaw = overrides?.turnId ?? event.turnId;
  const itemIdRaw = overrides?.itemId ?? event.itemId;
  const requestIdRaw = overrides?.requestId ?? event.requestId;
  const rawPayload =
    event.payload ?? (event.message ? { message: event.message } : { method: event.method, kind: event.kind });

  return {
    eventId: event.id,
    provider: event.provider,
    sessionId: event.sessionId,
    createdAt: event.createdAt,
    ...(threadIdRaw ? { threadId: ProviderThreadId.makeUnsafe(threadIdRaw) } : {}),
    ...(turnIdRaw ? { turnId: ProviderTurnId.makeUnsafe(turnIdRaw) } : {}),
    ...(itemIdRaw ? { itemId: ProviderItemId.makeUnsafe(itemIdRaw) } : {}),
    ...(requestIdRaw ? { requestId: ApprovalRequestId.makeUnsafe(requestIdRaw) } : {}),
    providerRefs: {
      providerSessionId: event.sessionId,
      ...(threadIdRaw ? { providerThreadId: ProviderThreadId.makeUnsafe(threadIdRaw) } : {}),
      ...(turnIdRaw ? { providerTurnId: ProviderTurnId.makeUnsafe(turnIdRaw) } : {}),
      ...(itemIdRaw ? { providerItemId: ProviderItemId.makeUnsafe(itemIdRaw) } : {}),
      ...(requestIdRaw ? { providerRequestId: requestIdRaw } : {}),
    },
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: rawPayload,
    },
  } as const;
}

function extractQuestions(payload: Record<string, unknown> | undefined): unknown {
  if (!payload) {
    return [];
  }
  if ("questions" in payload) {
    return payload.questions;
  }
  return payload;
}

function itemLifecyclePayload(
  method: "item/started" | "item/completed" | "item/reasoning/summaryPartAdded" | "item/commandExecution/terminalInteraction",
  item: Record<string, unknown> | undefined,
  payload: Record<string, unknown> | undefined,
) {
  const title = firstNonEmptyString(item?.title, item?.name, payload?.title);
  const detail = firstNonEmptyString(
    item?.command,
    item?.summary,
    item?.text,
    item?.path,
    payload?.command,
    payload?.message,
    payload?.prompt,
  );
  const statusFromPayload = toItemStatus(item?.status ?? payload?.status);
  const status =
    method === "item/started"
      ? (statusFromPayload ?? "inProgress")
      : method === "item/completed"
        ? (statusFromPayload ?? "completed")
        : statusFromPayload;
  return {
    itemType: toItemType(item?.type ?? item?.kind ?? payload?.itemType ?? method),
    ...(status ? { status } : {}),
    ...(title ? { title } : {}),
    ...(detail ? { detail } : {}),
    ...(payload ? { data: payload } : {}),
  };
}

function toPlanPayload(payload: Record<string, unknown> | undefined) {
  const explanation = asString(payload?.explanation) ?? null;
  const planEntries = asArray(payload?.plan) ?? [];
  const plan = planEntries
    .map((entry, index) => {
      const value = asObject(entry);
      const step =
        firstNonEmptyString(value?.step, value?.title, value?.description) ?? `Step ${index + 1}`;
      const status = normalizePlanStatus(value?.status);
      return { step, status } as const;
    })
    .filter((step) => step.step.trim().length > 0);
  return {
    ...(explanation !== null ? { explanation } : {}),
    plan,
  };
}

function mapToRuntimeEvents(event: ProviderEvent): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  const item = asObject(payload?.item);
  const threadIdFromPayload = asString(asObject(payload?.thread)?.id);
  const turnIdFromPayload = asString(turn?.id) ?? asString(payload?.turnId);
  const itemIdFromPayload = asString(item?.id) ?? asString(payload?.itemId);
  const summaryIndex = asNumber(payload?.summaryIndex);
  const contentIndex = asNumber(payload?.contentIndex);
  const requestType = toRequestType(event.method, event.requestKind);
  const requestId = event.requestId ? String(event.requestId) : undefined;

  if (event.kind === "error") {
    const message =
      firstNonEmptyString(event.message, asString(asObject(payload?.error)?.message), asString(payload?.message)) ??
      "Codex provider runtime error";
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
          ...(turnIdFromPayload ? { turnId: turnIdFromPayload } : {}),
          ...(itemIdFromPayload ? { itemId: itemIdFromPayload } : {}),
        }),
        type: "runtime.error",
        payload: {
          message,
          class: "provider_error",
          ...(payload ? { detail: payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    const detail = firstNonEmptyString(
      payload?.command,
      payload?.reason,
      payload?.prompt,
      payload?.message,
      payload?.detail,
    );
    const openedEvent: ProviderRuntimeEvent = {
      ...buildBase(event, {
        ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
        ...(turnIdFromPayload ? { turnId: turnIdFromPayload } : {}),
        ...(itemIdFromPayload ? { itemId: itemIdFromPayload } : {}),
        ...(requestId ? { requestId } : {}),
      }),
      type: "request.opened",
      payload: {
        requestType,
        ...(detail ? { detail } : {}),
        ...(payload ? { args: payload } : {}),
      },
    };
    if (event.method === "item/tool/requestUserInput") {
      return [
        openedEvent,
        {
          ...buildBase(event, {
            ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
            ...(turnIdFromPayload ? { turnId: turnIdFromPayload } : {}),
            ...(itemIdFromPayload ? { itemId: itemIdFromPayload } : {}),
            ...(requestId ? { requestId } : {}),
          }),
          type: "user-input.requested",
          payload: {
            questions: extractQuestions(payload),
          },
        },
      ];
    }
    return [openedEvent];
  }

  if (
    (event.method === "item/requestApproval/decision" || event.method === "serverRequest/resolved") &&
    requestId
  ) {
    const decision = firstNonEmptyString(payload?.decision, payload?.resolution);
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
          ...(turnIdFromPayload ? { turnId: turnIdFromPayload } : {}),
          ...(itemIdFromPayload ? { itemId: itemIdFromPayload } : {}),
          requestId,
        }),
        type: "request.resolved",
        payload: {
          requestType,
          ...(decision ? { decision } : {}),
          ...(payload ? { resolution: payload } : {}),
        },
      },
    ];
  }

  const sessionState = mapStatusMethodToSessionState(event.method);
  if (event.method === "session/ready") {
    return [
      {
        ...buildBase(event),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(payload ? { resume: payload } : {}),
        },
      },
      {
        ...buildBase(event),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (sessionState) {
    if (event.method === "session/closed" || event.method === "session/exited") {
      return [
        {
          ...buildBase(event),
          type: "session.exited",
          payload: {
            ...(event.message ? { reason: event.message } : {}),
            recoverable: event.method === "session/closed",
            exitKind: event.method === "session/closed" ? "graceful" : "error",
          },
        },
      ];
    }

    return [
      {
        ...buildBase(event),
        type: "session.state.changed",
        payload: {
          state: sessionState,
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...buildBase(event),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(payload ? { resume: payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const threadId = event.threadId ?? threadIdFromPayload;
    if (!threadId) {
      return [];
    }
    return [
      {
        ...buildBase(event, { threadId }),
        type: "thread.started",
        payload: {
          providerThreadId: ProviderThreadId.makeUnsafe(threadId),
        },
      },
    ];
  }

  if (event.method === "thread/status/changed") {
    const status = toThreadState(payload?.status ?? asObject(payload?.threadStatus)?.state);
    if (!status) {
      return [];
    }
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
        }),
        type: "thread.state.changed",
        payload: {
          state: status,
          ...(payload ? { detail: payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/archived" || event.method === "thread/unarchived" || event.method === "thread/closed" || event.method === "thread/compacted") {
    const state =
      event.method === "thread/archived"
        ? "archived"
        : event.method === "thread/closed"
          ? "closed"
          : event.method === "thread/compacted"
            ? "compacted"
            : "active";
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
        }),
        type: "thread.state.changed",
        payload: {
          state,
          ...(payload ? { detail: payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
        }),
        type: "thread.metadata.updated",
        payload: {
          ...(firstNonEmptyString(payload?.threadName, payload?.name) ? { name: firstNonEmptyString(payload?.threadName, payload?.name) } : {}),
          ...(payload ? { metadata: payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
        }),
        type: "thread.token-usage.updated",
        payload: {
          usage: payload ?? event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
        }),
        type: "thread.realtime.started",
        payload: {
          ...(asString(payload?.realtimeSessionId) ? { realtimeSessionId: asString(payload?.realtimeSessionId) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
        }),
        type: "thread.realtime.item-added",
        payload: {
          item: payload?.item ?? event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
        }),
        type: "thread.realtime.audio.delta",
        payload: {
          audio: payload?.audio ?? event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const message = firstNonEmptyString(payload?.message, event.message) ?? "Realtime error";
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
        }),
        type: "thread.realtime.error",
        payload: { message },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
        }),
        type: "thread.realtime.closed",
        payload: {
          ...(firstNonEmptyString(payload?.reason, event.message) ? { reason: firstNonEmptyString(payload?.reason, event.message) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId ?? turnIdFromPayload;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
          turnId,
        }),
        type: "turn.started",
        payload: {
          ...(firstNonEmptyString(turn?.model, payload?.model) ? { model: firstNonEmptyString(turn?.model, payload?.model) } : {}),
          ...(firstNonEmptyString(turn?.effort, payload?.effort) ? { effort: firstNonEmptyString(turn?.effort, payload?.effort) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/completed") {
    const state = toTurnState(turn?.status) ?? "completed";
    const errorMessage = firstNonEmptyString(asObject(turn?.error)?.message, event.message);
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
          ...(turnIdFromPayload ? { turnId: turnIdFromPayload } : {}),
        }),
        type: "turn.completed",
        payload: {
          state,
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(asObject(turn?.modelUsage) ? { modelUsage: asObject(turn?.modelUsage) } : {}),
          ...(asNumber(turn?.totalCostUsd) !== undefined ? { totalCostUsd: asNumber(turn?.totalCostUsd) } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
          ...(turnIdFromPayload ? { turnId: turnIdFromPayload } : {}),
        }),
        type: "turn.aborted",
        payload: {
          reason: firstNonEmptyString(payload?.reason, event.message) ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
          ...(turnIdFromPayload ? { turnId: turnIdFromPayload } : {}),
        }),
        type: "turn.plan.updated",
        payload: toPlanPayload(payload),
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    const unifiedDiff = asString(payload?.unifiedDiff) ?? asString(payload?.diff) ?? "";
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
          ...(turnIdFromPayload ? { turnId: turnIdFromPayload } : {}),
        }),
        type: "turn.diff.updated",
        payload: { unifiedDiff },
      },
    ];
  }

  if (
    event.method === "item/started" ||
    event.method === "item/completed" ||
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    const resolvedItemId = event.itemId ?? itemIdFromPayload;
    const base = buildBase(event, {
      ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
      ...(turnIdFromPayload ? { turnId: turnIdFromPayload } : {}),
      ...(resolvedItemId ? { itemId: resolvedItemId } : {}),
    });
    const payloadShape = itemLifecyclePayload(event.method, item, payload);
    const type =
      event.method === "item/started"
        ? "item.started"
        : event.method === "item/completed"
          ? "item.completed"
          : "item.updated";
    return [{ ...base, type, payload: payloadShape }];
  }

  if (event.method === "error") {
    const message =
      firstNonEmptyString(asObject(payload?.error)?.message, event.message) ??
      "Codex server runtime error";
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
          ...(turnIdFromPayload ? { turnId: turnIdFromPayload } : {}),
          ...(itemIdFromPayload ? { itemId: itemIdFromPayload } : {}),
        }),
        type: "runtime.error",
        payload: {
          message,
          class: "provider_error",
          ...(payload ? { detail: payload } : {}),
        },
      },
    ];
  }

  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "item/plan/delta" ||
    event.method === "item/commandExecution/outputDelta" ||
    event.method === "item/fileChange/outputDelta" ||
    event.method === "item/reasoning/summaryTextDelta" ||
    event.method === "item/reasoning/textDelta"
  ) {
    const delta =
      firstNonEmptyString(
        event.textDelta,
        payload?.delta,
        payload?.text,
        payload?.outputDelta,
        payload?.summaryTextDelta,
        payload?.textDelta,
      ) ?? "";
    if (delta.length === 0) {
      return [];
    }
    const streamKind =
      event.method === "item/agentMessage/delta"
        ? "assistant_text"
        : event.method === "item/plan/delta"
          ? "plan_text"
          : event.method === "item/commandExecution/outputDelta"
            ? "command_output"
            : event.method === "item/fileChange/outputDelta"
              ? "file_change_output"
              : event.method === "item/reasoning/summaryTextDelta"
                ? "reasoning_summary_text"
                : "reasoning_text";
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
          ...(turnIdFromPayload ? { turnId: turnIdFromPayload } : {}),
          ...(itemIdFromPayload ? { itemId: itemIdFromPayload } : {}),
        }),
        type: "content.delta",
        payload: {
          streamKind,
          delta,
          ...(contentIndex !== undefined ? { contentIndex } : {}),
          ...(summaryIndex !== undefined ? { summaryIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    const summary = firstNonEmptyString(payload?.summary, payload?.message);
    return [
      {
        ...buildBase(event, {
          ...(threadIdFromPayload ? { threadId: threadIdFromPayload } : {}),
          ...(turnIdFromPayload ? { turnId: turnIdFromPayload } : {}),
          ...(itemIdFromPayload ? { itemId: itemIdFromPayload } : {}),
        }),
        type: "tool.progress",
        payload: {
          ...(asString(payload?.toolUseId) ? { toolUseId: asString(payload?.toolUseId) } : {}),
          ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
          ...(summary ? { summary } : {}),
          ...(asNumber(payload?.elapsedSeconds) !== undefined
            ? { elapsedSeconds: asNumber(payload?.elapsedSeconds) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    const fromModel = firstNonEmptyString(payload?.fromModel);
    const toModel = firstNonEmptyString(payload?.toModel);
    const reason = firstNonEmptyString(payload?.reason);
    if (!fromModel || !toModel || !reason) {
      return [];
    }
    return [
      {
        ...buildBase(event),
        type: "model.rerouted",
        payload: {
          fromModel,
          toModel,
          reason,
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    const summary = firstNonEmptyString(payload?.summary, event.message);
    if (!summary) {
      return [];
    }
    return [
      {
        ...buildBase(event),
        type: "deprecation.notice",
        payload: {
          summary,
          ...(firstNonEmptyString(payload?.details) ? { details: firstNonEmptyString(payload?.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    const summary = firstNonEmptyString(payload?.summary, event.message);
    if (!summary) {
      return [];
    }
    return [
      {
        ...buildBase(event),
        type: "config.warning",
        payload: {
          summary,
          ...(firstNonEmptyString(payload?.details) ? { details: firstNonEmptyString(payload?.details) } : {}),
          ...(firstNonEmptyString(payload?.path) ? { path: firstNonEmptyString(payload?.path) } : {}),
          ...(payload?.range !== undefined ? { range: payload.range } : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    return [
      {
        ...buildBase(event),
        type: "account.updated",
        payload: {
          account: payload ?? event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    return [
      {
        ...buildBase(event),
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: payload ?? event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    return [
      {
        ...buildBase(event),
        type: "mcp.oauth.completed",
        payload: {
          success: asBoolean(payload?.success) ?? false,
          ...(firstNonEmptyString(payload?.name) ? { name: firstNonEmptyString(payload?.name) } : {}),
          ...(firstNonEmptyString(payload?.error) ? { error: firstNonEmptyString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "account/login/completed") {
    return [
      {
        ...buildBase(event),
        type: "auth.status",
        payload: {
          isAuthenticating: false,
          ...(firstNonEmptyString(event.message) ? { output: [firstNonEmptyString(event.message)!] } : {}),
          ...(firstNonEmptyString(payload?.error) ? { error: firstNonEmptyString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    return [
      {
        ...buildBase(event),
        type: "session.state.changed",
        payload: {
          state: asBoolean(payload?.success) === false ? "error" : "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
      {
        ...buildBase(event),
        type: "runtime.warning",
        payload: {
          message:
            firstNonEmptyString(event.message, payload?.message) ??
            "Windows sandbox setup completed",
          ...(payload ? { detail: payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windows/worldWritableWarning" || event.method === "app/list/updated") {
    return [
      {
        ...buildBase(event),
        type: "runtime.warning",
        payload: {
          message:
            firstNonEmptyString(event.message, payload?.message) ??
            `Unhandled codex notification: ${event.method}`,
          ...(payload ? { detail: payload } : {}),
        },
      },
    ];
  }

  return [
    {
      ...buildBase(event),
      type: "runtime.warning",
      payload: {
        message: `Unhandled codex notification: ${event.method}`,
        ...(payload ? { detail: payload } : {}),
      },
    },
  ];
}

const makeCodexAdapter = (options?: CodexAdapterLiveOptions) =>
  Effect.gen(function* () {
    const nativeEventLogger =
      options?.nativeEventLogPath !== undefined
        ? makeEventNdjsonLogger(options.nativeEventLogPath)
        : undefined;

    const manager = yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (options?.manager) {
          return options.manager;
        }
        if (options?.makeManager) {
          return options.makeManager();
        }
        return new CodexAppServerManager();
      }),
      (manager) =>
        Effect.sync(() => {
          try {
            manager.stopAll();
          } catch {
            // Finalizers should never fail and block shutdown.
          }
        }),
    );

    const startSession: CodexAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      return Effect.tryPromise({
        try: () => manager.startSession(input),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            sessionId: "pending",
            detail: toMessage(cause, "Failed to start Codex adapter session."),
            cause,
          }),
      });
    };

    const sendTurn: CodexAdapterShape["sendTurn"] = (input) =>
      Effect.tryPromise({
        try: () => manager.sendTurn(input),
        catch: (cause) => toRequestError(input.sessionId, "turn/start", cause),
      });

    const interruptTurn: CodexAdapterShape["interruptTurn"] = (sessionId, turnId) =>
      Effect.tryPromise({
        try: () => manager.interruptTurn(sessionId, turnId),
        catch: (cause) => toRequestError(sessionId, "turn/interrupt", cause),
      });

    const readThread: CodexAdapterShape["readThread"] = (sessionId) =>
      Effect.tryPromise({
        try: () => manager.readThread(sessionId),
        catch: (cause) => toRequestError(sessionId, "thread/read", cause),
      });

    const rollbackThread: CodexAdapterShape["rollbackThread"] = (sessionId, numTurns) => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          }),
        );
      }

      return Effect.tryPromise({
        try: () => manager.rollbackThread(sessionId, numTurns),
        catch: (cause) => toRequestError(sessionId, "thread/rollback", cause),
      });
    };

    const respondToRequest: CodexAdapterShape["respondToRequest"] = (
      sessionId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToRequest(sessionId, requestId, decision),
        catch: (cause) => toRequestError(sessionId, "item/requestApproval/decision", cause),
      });

    const stopSession: CodexAdapterShape["stopSession"] = (sessionId) =>
      Effect.sync(() => {
        manager.stopSession(sessionId);
      });

    const listSessions: CodexAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const hasSession: CodexAdapterShape["hasSession"] = (sessionId) =>
      Effect.sync(() => manager.hasSession(sessionId));

    const stopAll: CodexAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        manager.stopAll();
      });

    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (event: ProviderEvent) => {
          nativeEventLogger?.write({
            observedAt: new Date().toISOString(),
            event,
          });
          Queue.offerAllUnsafe(runtimeEventQueue, mapToRuntimeEvents(event));
        };
        manager.on("event", listener);
        return listener;
      }),
      (listener) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            manager.off("event", listener);
          });
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    return {
      provider: PROVIDER,
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies CodexAdapterShape;
  });

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
