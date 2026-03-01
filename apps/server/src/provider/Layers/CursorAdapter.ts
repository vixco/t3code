/**
 * CursorAdapterLive - Scoped live implementation for the Cursor ACP provider adapter.
 *
 * Implements JSON-RPC 2.0 over stdio for `agent acp`, projects ACP session updates
 * into canonical provider runtime events, and bridges external approval requests.
 *
 * @module CursorAdapterLive
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  ProviderSessionId,
  type ProviderSession,
  type ProviderSessionStartInput,
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
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { CursorAdapter, type CursorAdapterShape } from "../Services/CursorAdapter.ts";

const PROVIDER = "cursor" as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRpcRequest {
  readonly method: string;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface PendingPermissionRequest {
  readonly jsonRpcId: string | number;
  readonly requestType:
    | "command_execution_approval"
    | "file_change_approval"
    | "apply_patch_approval"
    | "exec_command_approval"
    | "tool_user_input"
    | "dynamic_tool_call"
    | "auth_tokens_refresh"
    | "unknown";
  readonly options: ReadonlyArray<string>;
}

interface ToolInFlight {
  readonly itemId: ProviderItemId;
  readonly itemType: "command_execution" | "file_change" | "dynamic_tool_call";
  title?: string;
  detail?: string;
}

interface CursorTurnState {
  readonly turnId: ProviderTurnId;
  readonly assistantItemId: ProviderItemId;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  assistantCompleted: boolean;
  assistantText: string;
}

interface CursorSessionContext {
  session: ProviderSession;
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutRl: readline.Interface;
  readonly stderrRl: readline.Interface;
  readonly pendingRequests: Map<string, PendingRpcRequest>;
  readonly pendingPermissions: Map<ApprovalRequestId, PendingPermissionRequest>;
  readonly toolsByToolCallId: Map<string, ToolInFlight>;
  readonly turns: Array<{ id: ProviderTurnId; items: ReadonlyArray<unknown> }>;
  turnState: CursorTurnState | undefined;
  acpSessionId: string | undefined;
  nextRequestId: number;
  stopping: boolean;
}

interface CursorResumeState {
  readonly sessionId?: string;
  readonly turnCount?: number;
}

interface JsonRpcResponseEnvelope {
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly data?: unknown;
  };
}

interface JsonRpcRequestEnvelope {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcNotificationEnvelope {
  readonly method: string;
  readonly params?: unknown;
}

export interface CursorAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly spawnProcess?: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
  }) => ChildProcessWithoutNullStreams;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.length > 0) {
    return cause;
  }
  if (cause && typeof cause === "object") {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return fallback;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstNonEmptyString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function asRpcError(
  cause: unknown,
): { readonly code?: number; readonly message: string; readonly data?: unknown } | undefined {
  const object = asObject(cause);
  if (!object) {
    return undefined;
  }
  const code = asNumber(object.code);
  const message = asString(object.message);
  if (!message) {
    return undefined;
  }
  return {
    ...(code !== undefined ? { code } : {}),
    message,
    ...(object.data !== undefined ? { data: object.data } : {}),
  };
}

function toSessionError(
  sessionId: ProviderSessionId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      sessionId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
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

function mapStopReasonToTurnState(value: string | undefined): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    default:
      return "completed";
  }
}

function mapPermissionRequestType(
  toolCall: unknown,
):
  | "command_execution_approval"
  | "file_change_approval"
  | "apply_patch_approval"
  | "exec_command_approval"
  | "tool_user_input"
  | "dynamic_tool_call"
  | "auth_tokens_refresh"
  | "unknown" {
  const record = asObject(toolCall);
  const kind = asString(record?.kind)?.toLowerCase();
  if (!kind) {
    return "unknown";
  }
  if (kind.includes("execute") || kind.includes("terminal") || kind.includes("command")) {
    return "command_execution_approval";
  }
  if (kind.includes("edit") || kind.includes("write") || kind.includes("file")) {
    return "file_change_approval";
  }
  return "unknown";
}

function classifyToolItemType(input: {
  readonly kind?: string;
  readonly title?: string;
  readonly rawInput?: unknown;
}): "command_execution" | "file_change" | "dynamic_tool_call" {
  const kind = input.kind?.toLowerCase();
  const title = input.title?.toLowerCase();
  const rawInput = asObject(input.rawInput);
  const command = firstNonEmptyString(rawInput?.command, rawInput?.cmd);

  if (
    (kind && (kind.includes("execute") || kind.includes("terminal") || kind.includes("command"))) ||
    (title && (title.includes("terminal") || title.includes("bash"))) ||
    command
  ) {
    return "command_execution";
  }

  if (
    (kind && (kind.includes("edit") || kind.includes("write") || kind.includes("file"))) ||
    (title && title.includes("file"))
  ) {
    return "file_change";
  }

  return "dynamic_tool_call";
}

function summarizeToolInput(rawInput: unknown, title?: string): string | undefined {
  const input = asObject(rawInput);
  const command = firstNonEmptyString(input?.command, input?.cmd);
  if (command) {
    return command;
  }
  return firstNonEmptyString(title);
}

function summarizeToolOutput(rawOutput: unknown): string | undefined {
  const output = asObject(rawOutput);
  if (!output) {
    return undefined;
  }
  const exitCode = asNumber(output.exitCode);
  const stdout = firstNonEmptyString(output.stdout);
  const stderr = firstNonEmptyString(output.stderr);
  const summary = firstNonEmptyString(output.summary, output.message);

  if (summary) {
    return summary;
  }
  if (exitCode !== undefined || stdout || stderr) {
    const chunks: Array<string> = [];
    if (exitCode !== undefined) chunks.push(`exit=${exitCode}`);
    if (stdout) chunks.push(`stdout=${stdout.slice(0, 160)}`);
    if (stderr) chunks.push(`stderr=${stderr.slice(0, 160)}`);
    return chunks.join(" ");
  }

  const serialized = JSON.stringify(output);
  return serialized.length > 240 ? `${serialized.slice(0, 237)}...` : serialized;
}

function readCursorResumeState(resumeCursor: unknown): CursorResumeState | undefined {
  const cursor = asObject(resumeCursor);
  if (!cursor) {
    return undefined;
  }
  const sessionId =
    firstNonEmptyString(cursor.sessionId, cursor.acpSessionId, cursor.providerSessionId) ?? undefined;
  const turnCountValue = cursor.turnCount;
  const turnCount =
    typeof turnCountValue === "number" && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? turnCountValue
      : undefined;
  if (!sessionId && turnCount === undefined) {
    return undefined;
  }
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
  };
}

function buildPrompt(input: ProviderSendTurnInput): Array<{ type: "text"; text: string }> {
  const chunks: Array<{ type: "text"; text: string }> = [];
  if (input.input && input.input.trim().length > 0) {
    chunks.push({ type: "text", text: input.input.trim() });
  }

  for (const attachment of input.attachments ?? []) {
    if (attachment.type === "image") {
      chunks.push({
        type: "text",
        text: `Attached image: ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
      });
    }
  }

  return chunks;
}

const makeCursorAdapter = (options?: CursorAdapterLiveOptions) =>
  Effect.gen(function* () {
    const nativeEventLogger =
      options?.nativeEventLogPath !== undefined
        ? makeEventNdjsonLogger(options.nativeEventLogPath)
        : undefined;

    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ProviderSessionId, CursorSessionContext>();

    const stamp = () => ({
      eventId: EventId.makeUnsafe(randomUUID()),
      createdAt: new Date().toISOString(),
    });

    const emitRuntimeEvent = (event: ProviderRuntimeEvent): void => {
      Queue.offerAllUnsafe(runtimeEventQueue, [event]);
    };

    const logNative = (record: unknown) => {
      nativeEventLogger?.write({
        observedAt: new Date().toISOString(),
        record,
      });
    };

    const baseEvent = (
      context: CursorSessionContext,
      raw: {
        readonly source: "cursor.acp.notification" | "cursor.acp.request" | "cursor.acp.response";
        readonly method: string;
        readonly payload: unknown;
      },
      overrides?: {
        readonly turnId?: ProviderTurnId;
        readonly itemId?: ProviderItemId;
        readonly requestId?: ApprovalRequestId;
      },
) => {
      const eventStamp = stamp();
      const threadId = context.session.threadId;
      const turnId = overrides?.turnId ?? context.turnState?.turnId;
      return {
        eventId: eventStamp.eventId,
        provider: PROVIDER,
        sessionId: context.session.sessionId,
        createdAt: eventStamp.createdAt,
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(overrides?.itemId ? { itemId: overrides.itemId } : {}),
        ...(overrides?.requestId ? { requestId: overrides.requestId } : {}),
        providerRefs: {
          providerSessionId: context.session.sessionId,
          ...(threadId ? { providerThreadId: threadId } : {}),
          ...(turnId ? { providerTurnId: turnId } : {}),
          ...(overrides?.itemId ? { providerItemId: overrides.itemId } : {}),
          ...(overrides?.requestId ? { providerRequestId: overrides.requestId } : {}),
        },
        raw,
      } as const;
    };

    const rejectPendingRequests = (context: CursorSessionContext, message: string) => {
      for (const [id, pending] of context.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(message));
        context.pendingRequests.delete(id);
      }
    };

    const completeTurn = (
      context: CursorSessionContext,
      state: "completed" | "failed" | "interrupted" | "cancelled",
      options?: {
        readonly stopReason?: string;
        readonly errorMessage?: string;
      },
    ) => {
      const turnState = context.turnState;
      if (!turnState) {
        return;
      }

      if (!turnState.assistantCompleted) {
        emitRuntimeEvent({
          ...baseEvent(
            context,
            {
              source: "cursor.acp.response",
              method: "session/prompt",
              payload: {
                stopReason: options?.stopReason ?? null,
              },
            },
            { itemId: turnState.assistantItemId, turnId: turnState.turnId },
          ),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: state === "failed" ? "failed" : "completed",
            ...(turnState.assistantText.length > 0 ? { detail: turnState.assistantText.slice(0, 200) } : {}),
          },
        });
        turnState.assistantCompleted = true;
      }

      context.turns.push({
        id: turnState.turnId,
        items: [...turnState.items],
      });

      emitRuntimeEvent({
        ...baseEvent(
          context,
          {
            source: "cursor.acp.response",
            method: "session/prompt",
            payload: {
              stopReason: options?.stopReason ?? null,
            },
          },
          { turnId: turnState.turnId },
        ),
        type: "turn.completed",
        payload: {
          state,
          ...(options?.stopReason ? { stopReason: options.stopReason } : {}),
          ...(options?.errorMessage ? { errorMessage: options.errorMessage } : {}),
        },
      });

      context.turnState = undefined;
      context.session = {
        ...context.session,
        status: state === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        updatedAt: new Date().toISOString(),
        ...(state === "failed" && options?.errorMessage ? { lastError: options.errorMessage } : {}),
      };
    };

    const stopSessionInternal = (
      context: CursorSessionContext,
      options?: {
        readonly emitExitEvent?: boolean;
      },
    ) => {
      if (context.stopping) {
        return;
      }
      context.stopping = true;

      for (const [requestId, pending] of context.pendingPermissions) {
        emitRuntimeEvent({
          ...baseEvent(
            context,
            {
              source: "cursor.acp.response",
              method: "session/request_permission",
              payload: {
                decision: "cancel",
              },
            },
            { requestId },
          ),
          type: "request.resolved",
          payload: {
            requestType: pending.requestType,
            decision: "cancel",
          },
        });
      }
      context.pendingPermissions.clear();

      if (context.turnState) {
        completeTurn(context, "interrupted", {
          errorMessage: "Session stopped.",
          stopReason: "interrupted",
        });
      }

      rejectPendingRequests(context, "Cursor ACP session stopped before request completed.");

      try {
        context.stdoutRl.close();
      } catch {
        // no-op
      }
      try {
        context.stderrRl.close();
      } catch {
        // no-op
      }
      try {
        if (!context.child.killed) {
          context.child.kill("SIGTERM");
        }
      } catch {
        // no-op
      }

      context.session = {
        ...context.session,
        status: "closed",
        activeTurnId: undefined,
        updatedAt: new Date().toISOString(),
      };

      if (options?.emitExitEvent !== false) {
        emitRuntimeEvent({
          ...baseEvent(context, {
            source: "cursor.acp.notification",
            method: "session/exited",
            payload: { reason: "Session stopped" },
          }),
          type: "session.exited",
          payload: {
            reason: "Session stopped",
            recoverable: true,
            exitKind: "graceful",
          },
        });
      }

      sessions.delete(context.session.sessionId);
    };

    const requireSession = (
      sessionId: ProviderSessionId,
    ): Effect.Effect<CursorSessionContext, ProviderAdapterError> => {
      const context = sessions.get(sessionId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            sessionId,
          }),
        );
      }
      if (context.stopping || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            sessionId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    const writeMessage = (context: CursorSessionContext, message: unknown): void => {
      if (!context.child.stdin.writable) {
        throw new Error("Cursor ACP stdin is not writable.");
      }
      logNative({
        direction: "client->server",
        sessionId: context.session.sessionId,
        message,
      });
      context.child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const sendRequest = (
      context: CursorSessionContext,
      method: string,
      params: unknown,
      timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = context.nextRequestId;
        context.nextRequestId += 1;
        const key = String(id);
        const timeout = setTimeout(() => {
          context.pendingRequests.delete(key);
          reject(new Error(`Timed out waiting for ${method}.`));
        }, timeoutMs);

        context.pendingRequests.set(key, {
          method,
          timeout,
          resolve,
          reject,
        });

        writeMessage(context, {
          jsonrpc: "2.0",
          id,
          method,
          params,
        });
      });

    const handleSessionUpdate = (
      context: CursorSessionContext,
      update: Record<string, unknown>,
      rawParams: unknown,
    ) => {
      const sessionUpdate = asString(update.sessionUpdate);
      if (!sessionUpdate) {
        emitRuntimeEvent({
          ...baseEvent(context, {
            source: "cursor.acp.notification",
            method: "session/update",
            payload: rawParams,
          }),
          type: "runtime.warning",
          payload: {
            message: "Cursor ACP session/update missing sessionUpdate discriminator.",
            detail: rawParams,
          },
        });
        return;
      }

      if (sessionUpdate === "available_commands_update") {
        emitRuntimeEvent({
          ...baseEvent(context, {
            source: "cursor.acp.notification",
            method: "session/update",
            payload: rawParams,
          }),
          type: "session.configured",
          payload: {
            config: {
              availableCommands: update.availableCommands ?? [],
            },
          },
        });
        return;
      }

      if (sessionUpdate === "agent_thought_chunk") {
        const text = firstNonEmptyString(asObject(update.content)?.text);
        if (!text) return;
        emitRuntimeEvent({
          ...baseEvent(context, {
            source: "cursor.acp.notification",
            method: "session/update",
            payload: rawParams,
          }),
          type: "content.delta",
          payload: {
            streamKind: "reasoning_text",
            delta: text,
          },
        });
        return;
      }

      if (sessionUpdate === "agent_message_chunk") {
        const text = firstNonEmptyString(asObject(update.content)?.text);
        if (!text) return;
        const assistantItemId =
          context.turnState?.assistantItemId ??
          ProviderItemId.makeUnsafe(`cursor-assistant-${randomUUID()}`);
        if (context.turnState) {
          context.turnState.assistantText = `${context.turnState.assistantText}${text}`;
          context.turnState.items.push({
            type: "agent_message_chunk",
            text,
          });
        }
        emitRuntimeEvent({
          ...baseEvent(
            context,
            {
              source: "cursor.acp.notification",
              method: "session/update",
              payload: rawParams,
            },
            { itemId: assistantItemId },
          ),
          type: "content.delta",
          payload: {
            streamKind: "assistant_text",
            delta: text,
          },
        });
        return;
      }

      if (sessionUpdate === "tool_call") {
        const toolCallId = asString(update.toolCallId);
        if (!toolCallId) return;
        const existing = context.toolsByToolCallId.get(toolCallId);
        const title = firstNonEmptyString(update.title) ?? "Tool call";
        const kind = firstNonEmptyString(update.kind);
        const rawInput = update.rawInput;
        const detail = summarizeToolInput(rawInput, title);
        const classifyInput = {
          ...(kind ? { kind } : {}),
          ...(title ? { title } : {}),
          ...(rawInput !== undefined ? { rawInput } : {}),
        };
        if (!existing) {
          const tool: ToolInFlight = {
            itemId: ProviderItemId.makeUnsafe(`cursor-tool-${toolCallId}`),
            itemType: classifyToolItemType(classifyInput),
            title,
            ...(detail ? { detail } : {}),
          };
          context.toolsByToolCallId.set(toolCallId, tool);
          context.turnState?.items.push({
            type: "tool_call",
            toolCallId,
            rawInput,
          });
          emitRuntimeEvent({
            ...baseEvent(
              context,
              {
                source: "cursor.acp.notification",
                method: "session/update",
                payload: rawParams,
              },
              { itemId: tool.itemId },
            ),
            type: "item.started",
            payload: {
              itemType: tool.itemType,
              status: "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: {
                toolCallId,
                rawInput,
              },
            },
          });
          return;
        }

        existing.title = title;
        if (detail !== undefined) {
          existing.detail = detail;
        } else {
          delete existing.detail;
        }
        emitRuntimeEvent({
          ...baseEvent(
            context,
            {
              source: "cursor.acp.notification",
              method: "session/update",
              payload: rawParams,
            },
            { itemId: existing.itemId },
          ),
          type: "item.updated",
          payload: {
            itemType: existing.itemType,
            status: "inProgress",
            title: existing.title,
            ...(existing.detail ? { detail: existing.detail } : {}),
            data: {
              toolCallId,
              rawInput,
            },
          },
        });
        return;
      }

      if (sessionUpdate === "tool_call_update") {
        const toolCallId = asString(update.toolCallId);
        if (!toolCallId) return;
        const status = firstNonEmptyString(update.status)?.toLowerCase() ?? "in_progress";
        const updateKind = firstNonEmptyString(update.kind);
        const updateTitle = firstNonEmptyString(update.title);
        const classifyInput = {
          ...(updateKind ? { kind: updateKind } : {}),
          ...(updateTitle ? { title: updateTitle } : {}),
          ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
        };
        const existing =
          context.toolsByToolCallId.get(toolCallId) ??
          ({
            itemId: ProviderItemId.makeUnsafe(`cursor-tool-${toolCallId}`),
            itemType: classifyToolItemType(classifyInput),
            title: updateTitle ?? "Tool call",
          } satisfies ToolInFlight);

        context.toolsByToolCallId.set(toolCallId, existing);
        const detail = summarizeToolOutput(update.rawOutput) ?? existing.detail;

        if (status === "completed") {
          context.toolsByToolCallId.delete(toolCallId);
          context.turnState?.items.push({
            type: "tool_call_update",
            toolCallId,
            status,
            rawOutput: update.rawOutput,
          });
          const exitCode = asNumber(asObject(update.rawOutput)?.exitCode);
          const lifecycleStatus = exitCode !== undefined && exitCode !== 0 ? "failed" : "completed";
          emitRuntimeEvent({
            ...baseEvent(
              context,
              {
                source: "cursor.acp.notification",
                method: "session/update",
                payload: rawParams,
              },
              { itemId: existing.itemId },
            ),
            type: "item.completed",
            payload: {
              itemType: existing.itemType,
              status: lifecycleStatus,
              title: existing.title,
              ...(detail ? { detail } : {}),
              data: {
                toolCallId,
                rawOutput: update.rawOutput,
              },
            },
          });
          return;
        }

        emitRuntimeEvent({
          ...baseEvent(
            context,
            {
              source: "cursor.acp.notification",
              method: "session/update",
              payload: rawParams,
            },
            { itemId: existing.itemId },
          ),
          type: "item.updated",
          payload: {
            itemType: existing.itemType,
            status: "inProgress",
            title: existing.title,
            ...(detail ? { detail } : {}),
            data: {
              toolCallId,
              rawOutput: update.rawOutput,
            },
          },
        });
        return;
      }

      emitRuntimeEvent({
        ...baseEvent(context, {
          source: "cursor.acp.notification",
          method: "session/update",
          payload: rawParams,
        }),
        type: "runtime.warning",
        payload: {
          message: `Unhandled Cursor ACP session update: ${sessionUpdate}`,
          detail: rawParams,
        },
      });
    };

    const handleServerRequest = (context: CursorSessionContext, request: JsonRpcRequestEnvelope) => {
      if (request.method !== "session/request_permission") {
        writeMessage(context, {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            outcome: {
              outcome: "selected",
              optionId: "reject-once",
            },
          },
        });
        emitRuntimeEvent({
          ...baseEvent(context, {
            source: "cursor.acp.request",
            method: request.method,
            payload: request.params ?? {},
          }),
          type: "runtime.warning",
          payload: {
            message: `Unsupported Cursor ACP server request: ${request.method}`,
            detail: request.params ?? {},
          },
        });
        return;
      }

      const params = asObject(request.params);
      const options = asArray(params?.options) ?? [];
      const optionIds = options
        .map((option) => asString(asObject(option)?.optionId))
        .filter((value): value is string => value !== undefined);
      const requestType = mapPermissionRequestType(params?.toolCall);
      const requestId = ApprovalRequestId.makeUnsafe(randomUUID());

      context.pendingPermissions.set(requestId, {
        jsonRpcId: request.id,
        requestType,
        options: optionIds,
      });

      emitRuntimeEvent({
        ...baseEvent(
          context,
          {
            source: "cursor.acp.request",
            method: request.method,
            payload: request.params ?? {},
          },
          { requestId },
        ),
        type: "request.opened",
        payload: {
          requestType,
          ...(firstNonEmptyString(asObject(params?.toolCall)?.title, asObject(params?.toolCall)?.kind)
            ? {
                detail: firstNonEmptyString(
                  asObject(params?.toolCall)?.title,
                  asObject(params?.toolCall)?.kind,
                ),
              }
            : {}),
          args: request.params ?? {},
        },
      });
    };

    const handleNotification = (
      context: CursorSessionContext,
      notification: JsonRpcNotificationEnvelope,
    ) => {
      if (notification.method === "session/update") {
        const params = asObject(notification.params);
        const update = asObject(params?.update);
        if (!update) {
          emitRuntimeEvent({
            ...baseEvent(context, {
              source: "cursor.acp.notification",
              method: notification.method,
              payload: notification.params ?? {},
            }),
            type: "runtime.warning",
            payload: {
              message: "Cursor ACP session/update is missing params.update.",
              detail: notification.params ?? {},
            },
          });
          return;
        }
        handleSessionUpdate(context, update, notification.params ?? {});
        return;
      }

      emitRuntimeEvent({
        ...baseEvent(context, {
          source: "cursor.acp.notification",
          method: notification.method,
          payload: notification.params ?? {},
        }),
        type: "runtime.warning",
        payload: {
          message: `Unhandled Cursor ACP notification: ${notification.method}`,
          detail: notification.params ?? {},
        },
      });
    };

    const handleResponse = (context: CursorSessionContext, response: JsonRpcResponseEnvelope) => {
      const key = String(response.id);
      const pending = context.pendingRequests.get(key);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      context.pendingRequests.delete(key);

      if (response.error) {
        pending.reject(
          new Error(`${pending.method} failed: ${response.error.message ?? "Unknown JSON-RPC error"}`, {
            cause: response.error,
          }),
        );
        return;
      }

      pending.resolve(response.result);
    };

    const handleStdoutLine = (context: CursorSessionContext, line: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        emitRuntimeEvent({
          ...baseEvent(context, {
            source: "cursor.acp.notification",
            method: "protocol/parseError",
            payload: line,
          }),
          type: "runtime.warning",
          payload: {
            message: "Cursor ACP emitted invalid JSON.",
            detail: line,
          },
        });
        return;
      }

      logNative({
        direction: "server->client",
        sessionId: context.session.sessionId,
        message: parsed,
      });

      const message = asObject(parsed);
      if (!message) return;
      const method = asString(message.method);
      const id = message.id;
      const hasId = typeof id === "string" || typeof id === "number";

      if (hasId && method) {
        handleServerRequest(context, {
          id,
          method,
          params: message.params,
        });
        return;
      }

      if (hasId && !method) {
        const responseErrorObject = asObject(message.error);
        const responseErrorCode = asNumber(responseErrorObject?.code);
        const responseErrorMessage = asString(responseErrorObject?.message);
        const responseError = responseErrorObject
          ? {
              ...(responseErrorCode !== undefined ? { code: responseErrorCode } : {}),
              ...(responseErrorMessage !== undefined ? { message: responseErrorMessage } : {}),
              ...(responseErrorObject.data !== undefined ? { data: responseErrorObject.data } : {}),
            }
          : undefined;
        handleResponse(context, {
          id,
          ...(message.result !== undefined ? { result: message.result } : {}),
          ...(responseError ? { error: responseError } : {}),
        });
        return;
      }

      if (!hasId && method) {
        handleNotification(context, {
          method,
          params: message.params,
        });
      }
    };

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const sessionId = ProviderSessionId.makeUnsafe(`cursor-session-${randomUUID()}`);
        const startedAt = new Date().toISOString();
        const cursorOptions = input.providerOptions?.cursor as { binaryPath?: string } | undefined;
        const binaryPath = cursorOptions?.binaryPath ?? "agent";
        const cwd = input.cwd ?? process.cwd();
        const spawnProcess =
          options?.spawnProcess ??
          ((spawnInput: { readonly binaryPath: string; readonly cwd: string }) =>
            spawn(spawnInput.binaryPath, ["acp"], {
              cwd: spawnInput.cwd,
              stdio: ["pipe", "pipe", "pipe"],
              env: {
                ...process.env,
                NO_COLOR: "1",
              },
            }));

        let context: CursorSessionContext | undefined;

        try {
          const child = spawnProcess({ binaryPath, cwd });

          const stdoutRl = readline.createInterface({ input: child.stdout });
          const stderrRl = readline.createInterface({ input: child.stderr });

          const session: ProviderSession = {
            sessionId,
            provider: PROVIDER,
            status: "connecting",
            cwd,
            ...(input.model ? { model: input.model } : {}),
            resumeCursor: {
              turnCount: 0,
            },
            createdAt: startedAt,
            updatedAt: startedAt,
          };

          context = {
            session,
            child,
            stdoutRl,
            stderrRl,
            pendingRequests: new Map(),
            pendingPermissions: new Map(),
            toolsByToolCallId: new Map(),
            turns: [],
            turnState: undefined,
            acpSessionId: undefined,
            nextRequestId: 1,
            stopping: false,
          };
          sessions.set(sessionId, context);

          stdoutRl.on("line", (line) => handleStdoutLine(context!, line));
          stderrRl.on("line", (line) => {
            logNative({
              direction: "stderr",
              sessionId: context?.session.sessionId,
              line,
            });
            const message = line.trim();
            if (message.length === 0) return;
            emitRuntimeEvent({
              ...baseEvent(context!, {
                source: "cursor.acp.notification",
                method: "process/stderr",
                payload: line,
              }),
              type: "runtime.warning",
              payload: {
                message,
              },
            });
          });

          child.on("exit", (code, signal) => {
            if (!context || context.stopping) {
              return;
            }

            const message = `Cursor ACP exited (code=${String(code)}, signal=${String(signal)}).`;
            rejectPendingRequests(context, message);
            completeTurn(context, "failed", {
              errorMessage: message,
              stopReason: "failed",
            });
            emitRuntimeEvent({
              ...baseEvent(context, {
                source: "cursor.acp.notification",
                method: "session/exited",
                payload: { code, signal },
              }),
              type: "runtime.error",
              payload: {
                message,
                class: "transport_error",
                detail: { code, signal },
              },
            });
            emitRuntimeEvent({
              ...baseEvent(context, {
                source: "cursor.acp.notification",
                method: "session/exited",
                payload: { code, signal },
              }),
              type: "session.exited",
              payload: {
                reason: message,
                recoverable: true,
                exitKind: "error",
              },
            });
            sessions.delete(context.session.sessionId);
          });

          const initializeResult = yield* Effect.tryPromise({
            try: () =>
              sendRequest(context!, "initialize", {
                protocolVersion: 1,
                clientCapabilities: {
                  fs: { readTextFile: false, writeTextFile: false },
                  terminal: false,
                },
                clientInfo: {
                  name: "t3code_cursor_adapter",
                  version: "0.1.0",
                },
              }),
            catch: (cause) => toRequestError(sessionId, "initialize", cause),
          });

          emitRuntimeEvent({
            ...baseEvent(context, {
              source: "cursor.acp.response",
              method: "initialize",
              payload: initializeResult,
            }),
            type: "session.configured",
            payload: {
              config: asObject(initializeResult) ?? { initializeResult },
            },
          });

          const authenticateResult = yield* Effect.tryPromise({
            try: () =>
              sendRequest(context!, "authenticate", {
                methodId: "cursor_login",
              }),
            catch: (cause) => toRequestError(sessionId, "authenticate", cause),
          });

          emitRuntimeEvent({
            ...baseEvent(context, {
              source: "cursor.acp.response",
              method: "authenticate",
              payload: authenticateResult,
            }),
            type: "auth.status",
            payload: {
              isAuthenticating: false,
            },
          });

          const resumeState = readCursorResumeState(input.resumeCursor);
          const sessionResult = yield* Effect.tryPromise({
            try: () =>
              resumeState?.sessionId
                ? sendRequest(context!, "session/load", {
                    sessionId: resumeState.sessionId,
                    cwd,
                    mcpServers: [],
                    ...(input.model ? { model: input.model } : {}),
                  })
                : sendRequest(context!, "session/new", {
                    cwd,
                    mcpServers: [],
                    ...(input.model ? { model: input.model } : {}),
                  }),
            catch: (cause) => toRequestError(sessionId, "session/new", cause),
          });

          const acpSessionId = firstNonEmptyString(asObject(sessionResult)?.sessionId);
          if (!acpSessionId) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              sessionId,
              detail: "Cursor ACP session/new response did not include a sessionId.",
              cause: sessionResult,
            });
          }

          const threadId = ProviderThreadId.makeUnsafe(acpSessionId);
          context.acpSessionId = acpSessionId;
          context.session = {
            ...context.session,
            status: "ready",
            threadId,
            resumeCursor: {
              sessionId: acpSessionId,
              turnCount: resumeState?.turnCount ?? 0,
            },
            updatedAt: new Date().toISOString(),
          };

          emitRuntimeEvent({
            ...baseEvent(context, {
              source: "cursor.acp.response",
              method: resumeState?.sessionId ? "session/load" : "session/new",
              payload: sessionResult,
            }),
            type: "session.started",
            payload: {
              ...(resumeState ? { resume: resumeState } : {}),
            },
          });
          emitRuntimeEvent({
            ...baseEvent(context, {
              source: "cursor.acp.response",
              method: resumeState?.sessionId ? "session/load" : "session/new",
              payload: sessionResult,
            }),
            type: "thread.started",
            payload: {
              providerThreadId: threadId,
            },
          });
          emitRuntimeEvent({
            ...baseEvent(context, {
              source: "cursor.acp.response",
              method: resumeState?.sessionId ? "session/load" : "session/new",
              payload: sessionResult,
            }),
            type: "session.state.changed",
            payload: {
              state: "ready",
            },
          });

          return { ...context.session };
        } catch (cause) {
          if (context) {
            stopSessionInternal(context, { emitExitEvent: false });
            sessions.delete(context.session.sessionId);
          }
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            sessionId,
            detail: toMessage(cause, "Failed to start Cursor ACP session."),
            cause,
          });
        }
      });

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.sessionId);
        if (context.turnState) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Session '${input.sessionId}' already has an active turn '${context.turnState.turnId}'.`,
          });
        }
        if (!context.acpSessionId) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            sessionId: input.sessionId,
          });
        }

        const prompt = buildPrompt(input);
        if (prompt.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn input must include text or attachments.",
          });
        }

        const turnId = ProviderTurnId.makeUnsafe(`cursor-turn-${randomUUID()}`);
        const assistantItemId = ProviderItemId.makeUnsafe(`cursor-assistant-${randomUUID()}`);
        context.turnState = {
          turnId,
          assistantItemId,
          startedAt: new Date().toISOString(),
          items: [],
          assistantCompleted: false,
          assistantText: "",
        };
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: new Date().toISOString(),
        };

        emitRuntimeEvent({
          ...baseEvent(
            context,
            {
              source: "cursor.acp.request",
              method: "session/prompt",
              payload: {
                sessionId: context.acpSessionId,
                prompt,
              },
            },
            { turnId },
          ),
          type: "turn.started",
          payload: {
            ...(firstNonEmptyString(input.model, context.session.model)
              ? { model: firstNonEmptyString(input.model, context.session.model) }
              : {}),
          },
        });

        const promptResult = yield* Effect.tryPromise({
          try: () =>
            sendRequest(context, "session/prompt", {
              sessionId: context.acpSessionId,
              prompt,
            }),
          catch: (cause) => toRequestError(input.sessionId, "session/prompt", cause),
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const rpcError = asRpcError((error as { cause?: unknown }).cause ?? error);
              const message = rpcError?.message ?? toMessage(error, "Cursor prompt failed.");
              emitRuntimeEvent({
                ...baseEvent(
                  context,
                  {
                    source: "cursor.acp.response",
                    method: "session/prompt",
                    payload: {
                      ...(rpcError ? { error: rpcError } : { error }),
                    },
                  },
                  { turnId },
                ),
                type: "runtime.error",
                payload: {
                  message,
                  class:
                    rpcError?.code === -32601
                      ? "validation_error"
                      : rpcError?.code === -32602
                        ? "validation_error"
                        : rpcError?.code === -32603
                          ? "provider_error"
                          : "provider_error",
                  ...(rpcError ? { detail: rpcError } : {}),
                },
              });
              completeTurn(context, "failed", {
                stopReason: "failed",
                errorMessage: message,
              });
              return yield* Effect.fail(error);
            }),
          ),
        );

        const stopReason = firstNonEmptyString(asObject(promptResult)?.stopReason) ?? "end_turn";
        const turnState = mapStopReasonToTurnState(stopReason);
        completeTurn(context, turnState, {
          stopReason,
          ...(turnState === "failed" ? { errorMessage: "Cursor turn failed." } : {}),
        });
        context.session = {
          ...context.session,
          resumeCursor: {
            sessionId: context.acpSessionId,
            turnCount: context.turns.length,
          },
          updatedAt: new Date().toISOString(),
        };

        return {
          ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
          turnId,
          ...(context.session.resumeCursor ? { resumeCursor: context.session.resumeCursor } : {}),
        };
      });

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (sessionId, _turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        if (!context.turnState || !context.acpSessionId) {
          return;
        }
        const turnId = context.turnState.turnId;

        yield* Effect.tryPromise({
          try: () =>
            sendRequest(
              context,
              "session/cancel",
              {
                sessionId: context.acpSessionId,
              },
              15_000,
            ),
          catch: (cause) => toRequestError(sessionId, "session/cancel", cause),
        }).pipe(
          Effect.catch((error) => {
            const rpcError = asRpcError((error as { cause?: unknown }).cause ?? error);
            if (rpcError?.code !== -32601) {
              return Effect.fail(error);
            }
            emitRuntimeEvent({
              ...baseEvent(
                context,
                {
                  source: "cursor.acp.response",
                  method: "session/cancel",
                  payload: { error: rpcError },
                },
                { turnId },
              ),
              type: "runtime.warning",
              payload: {
                message: "Cursor ACP session/cancel is not supported; using interrupted fallback.",
                detail: rpcError,
              },
            });
            completeTurn(context, "interrupted", {
              stopReason: "interrupted",
              errorMessage: "Interrupted by fallback because session/cancel is unsupported.",
            });
            return Effect.void;
          }),
        );
      });

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (sessionId, requestId, decision) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        const pending = context.pendingPermissions.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending permission request: ${requestId}`,
          });
        }

        const preferredOptionId =
          decision === "acceptForSession"
            ? "allow-always"
            : decision === "accept"
              ? "allow-once"
              : "reject-once";
        const selectedOptionId =
          pending.options.find((candidate) => candidate === preferredOptionId) ??
          pending.options[0] ??
          preferredOptionId;

        yield* Effect.try({
          try: () => {
            writeMessage(context, {
              jsonrpc: "2.0",
              id: pending.jsonRpcId,
              result: {
                outcome: {
                  outcome: "selected",
                  optionId: selectedOptionId,
                },
              },
            });
          },
          catch: (cause) => toRequestError(sessionId, "session/request_permission", cause),
        });

        context.pendingPermissions.delete(requestId);

        emitRuntimeEvent({
          ...baseEvent(
            context,
            {
              source: "cursor.acp.response",
              method: "session/request_permission",
              payload: {
                optionId: selectedOptionId,
              },
            },
            { requestId },
          ),
          type: "request.resolved",
          payload: {
            requestType: pending.requestType,
            decision,
            resolution: {
              optionId: selectedOptionId,
            },
          },
        });
      });

    const readThread: CursorAdapterShape["readThread"] = (sessionId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        const threadId = context.session.threadId;
        if (!threadId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "readThread",
            issue: "Session thread id is not initialized yet.",
          });
        }
        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: [...turn.items],
          })),
        };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (sessionId, _numTurns) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: `Cursor ACP does not currently support thread rollback for session '${sessionId}'.`,
        }),
      );

    const stopSession: CursorAdapterShape["stopSession"] = (sessionId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        stopSessionInternal(context, { emitExitEvent: true });
      });

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: CursorAdapterShape["hasSession"] = (sessionId) =>
      Effect.sync(() => {
        const context = sessions.get(sessionId);
        return context !== undefined && !context.stopping;
      });

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        for (const context of sessions.values()) {
          stopSessionInternal(context, { emitExitEvent: true });
        }
      });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
      ),
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
    } satisfies CursorAdapterShape;
  });

export const CursorAdapterLive = Layer.effect(CursorAdapter, makeCursorAdapter());

export function makeCursorAdapterLive(options?: CursorAdapterLiveOptions) {
  return Layer.effect(CursorAdapter, makeCursorAdapter(options));
}
