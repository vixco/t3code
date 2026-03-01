/**
 * CursorAdapterLive - Scoped live implementation for the Cursor ACP provider adapter.
 *
 * Spawns `agent acp` child processes (one per session), implements JSON-RPC 2.0
 * multiplexing over stdio, and projects ACP notifications/requests into V2
 * canonical runtime events.
 *
 * @module CursorAdapterLive
 */
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  ProviderSessionId,
  type ProviderSession,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Cause, DateTime, Deferred, Effect, Layer, Queue, Random, Ref, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  CursorAdapter,
  type CursorAdapterShape,
  type AcpJsonRpcMessage,
  type AcpSessionUpdate,
} from "../Services/CursorAdapter.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "cursor" as const;
const ACP_BINARY = "agent";
const ACP_ARGS = ["acp"];
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export interface CursorAdapterLiveOptions {
  readonly binaryPath?: string;
  readonly nativeEventLogPath?: string;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  if (typeof cause === "string") return cause;
  if (cause && typeof cause === "object" && "message" in cause) {
    return String((cause as { message: unknown }).message);
  }
  return fallback;
}

function classifyToolItemType(kind: string | undefined, title: string | undefined): CanonicalItemType {
  if (kind === "execute") return "command_execution";
  const normalized = (title ?? "").toLowerCase();
  if (normalized.includes("terminal") || normalized.includes("shell")) return "command_execution";
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("file")) return "file_change";
  if (normalized.includes("search") || normalized.includes("grep") || normalized.includes("glob")) return "web_search";
  return "dynamic_tool_call";
}

function titleForItemType(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution": return "Command run";
    case "file_change": return "File change";
    case "web_search": return "Search";
    case "mcp_tool_call": return "MCP tool call";
    case "dynamic_tool_call": return "Tool call";
    default: return "Item";
  }
}

function classifyPermissionRequestType(kind: string | undefined): CanonicalRequestType {
  if (kind === "execute") return "command_execution_approval";
  return "unknown";
}

interface PendingRpcRequest {
  readonly deferred: Deferred.Deferred<unknown, ProviderAdapterError>;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingPermission {
  readonly jsonRpcId: number;
  readonly requestId: ApprovalRequestId;
  readonly requestType: CanonicalRequestType;
  readonly toolCallId: string;
}

interface CursorTurnState {
  readonly turnId: ProviderTurnId;
  readonly assistantItemId: string;
  readonly startedAt: string;
  readonly seenToolCallIds: Set<string>;
  emittedAssistantDelta: boolean;
}

interface CursorSessionContext {
  session: ProviderSession;
  acpSessionId: string;
  child: ChildProcess;
  nextRpcId: number;
  readonly pendingRpc: Map<number, PendingRpcRequest>;
  readonly pendingPermissions: Map<string, PendingPermission>;
  turnState: CursorTurnState | undefined;
  stopped: boolean;
}

function safeParse(line: string): AcpJsonRpcMessage | undefined {
  try {
    return JSON.parse(line) as AcpJsonRpcMessage;
  } catch {
    return undefined;
  }
}

function makeCursorAdapter(options?: CursorAdapterLiveOptions) {
  return Effect.gen(function* () {
    const nativeEventLogger =
      options?.nativeEventLogPath !== undefined
        ? makeEventNdjsonLogger(options.nativeEventLogPath)
        : undefined;

    const sessions = new Map<ProviderSessionId, CursorSessionContext>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const makeV2Base = (
      context: CursorSessionContext,
      stamp: { eventId: EventId; createdAt: string },
    ) => ({
      eventId: stamp.eventId,
      provider: PROVIDER,
      sessionId: RuntimeSessionId.makeUnsafe(context.session.sessionId),
      createdAt: stamp.createdAt,
      ...(context.session.threadId
        ? { threadId: ThreadId.makeUnsafe(context.session.threadId) }
        : {}),
      providerRefs: {
        providerSessionId: context.session.sessionId,
        ...(context.session.threadId
          ? { providerThreadId: context.session.threadId }
          : {}),
        ...(context.turnState
          ? { providerTurnId: context.turnState.turnId }
          : {}),
      },
    });

    const rpcRequest = (
      context: CursorSessionContext,
      method: string,
      params: unknown,
      timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Effect.Effect<unknown, ProviderAdapterError> =>
      Effect.gen(function* () {
        if (context.stopped) {
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            sessionId: context.session.sessionId,
          });
        }

        const id = context.nextRpcId++;
        const message = JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        });

        nativeEventLogger?.write({
          observedAt: new Date().toISOString(),
          event: {
            direction: "client->server",
            provider: PROVIDER,
            sessionId: context.session.sessionId,
            message: { jsonrpc: "2.0", id, method, params },
          },
        });

        const deferred = yield* Deferred.make<unknown, ProviderAdapterError>();

        const timer = setTimeout(() => {
          context.pendingRpc.delete(id);
          Effect.runFork(
            Deferred.fail(
              deferred,
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method,
                detail: `Timed out waiting for response (id=${id}).`,
              }),
            ),
          );
        }, timeoutMs);

        context.pendingRpc.set(id, { deferred, timer });

        yield* Effect.try({
          try: () => {
            context.child.stdin!.write(`${message}\n`);
          },
          catch: (err) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              sessionId: context.session.sessionId,
              detail: toMessage(err, "Failed to write to ACP stdin."),
              cause: err instanceof Error ? err : undefined,
            }),
        });

        return yield* Deferred.await(deferred);
      });

    const rpcRespond = (context: CursorSessionContext, id: number, result: unknown): void => {
      if (context.stopped) return;
      const message = JSON.stringify({ jsonrpc: "2.0", id, result });
      nativeEventLogger?.write({
        observedAt: new Date().toISOString(),
        event: {
          direction: "client->server",
          provider: PROVIDER,
          sessionId: context.session.sessionId,
          message: { jsonrpc: "2.0", id, result },
        },
      });
      try {
        context.child.stdin!.write(`${message}\n`);
      } catch {
        // Best-effort response delivery.
      }
    };

    const resolveRpcRequest = (context: CursorSessionContext, id: number, result: unknown): void => {
      const pending = context.pendingRpc.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      context.pendingRpc.delete(id);
      Effect.runFork(Deferred.succeed(pending.deferred, result));
    };

    const rejectRpcRequest = (context: CursorSessionContext, id: number, error: unknown): void => {
      const pending = context.pendingRpc.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      context.pendingRpc.delete(id);
      Effect.runFork(
        Deferred.fail(
          pending.deferred,
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rpc",
            detail: toMessage(error, "RPC request failed"),
            cause: error instanceof Error ? error : undefined,
          }),
        ),
      );
    };

    const handleSessionUpdate = (
      context: CursorSessionContext,
      update: AcpSessionUpdate,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const ts = context.turnState;

        switch (update.sessionUpdate) {
          case "agent_thought_chunk": {
            if (!update.content?.text || update.content.text.length === 0) return;
            const stamp = yield* makeEventStamp();
            yield* offerEvent({
              ...makeV2Base(context, stamp),
              ...(ts ? { turnId: TurnId.makeUnsafe(ts.turnId) } : {}),
              type: "content.delta" as const,
              payload: {
                streamKind: "reasoning_text" as const,
                delta: update.content.text,
              },
            });
            return;
          }

          case "agent_message_chunk": {
            if (!update.content?.text || update.content.text.length === 0) return;
            if (ts) ts.emittedAssistantDelta = true;
            const stamp = yield* makeEventStamp();
            yield* offerEvent({
              ...makeV2Base(context, stamp),
              ...(ts
                ? {
                    turnId: TurnId.makeUnsafe(ts.turnId),
                    itemId: RuntimeItemId.makeUnsafe(ts.assistantItemId),
                  }
                : {}),
              type: "content.delta" as const,
              payload: {
                streamKind: "assistant_text" as const,
                delta: update.content.text,
              },
            });
            return;
          }

          case "tool_call": {
            if (!update.toolCallId || !ts) return;
            if (ts.seenToolCallIds.has(update.toolCallId)) return;
            ts.seenToolCallIds.add(update.toolCallId);

            const itemType = classifyToolItemType(update.kind, update.title);
            const detail = update.rawInput && typeof update.rawInput === "object"
              ? (() => {
                  const cmd = (update.rawInput as Record<string, unknown>).command;
                  return typeof cmd === "string" ? cmd : update.title;
                })()
              : update.title;

            const stamp = yield* makeEventStamp();
            yield* offerEvent({
              ...makeV2Base(context, stamp),
              turnId: TurnId.makeUnsafe(ts.turnId),
              itemId: RuntimeItemId.makeUnsafe(update.toolCallId),
              type: "item.started" as const,
              payload: {
                itemType,
                status: "inProgress" as const,
                title: titleForItemType(itemType),
                ...(detail ? { detail: String(detail).slice(0, 400) } : {}),
              },
            });
            return;
          }

          case "tool_call_update": {
            if (!update.toolCallId || !ts) return;

            if (update.status === "completed") {
              const itemType = classifyToolItemType(undefined, undefined);
              const stamp = yield* makeEventStamp();
              yield* offerEvent({
                ...makeV2Base(context, stamp),
                turnId: TurnId.makeUnsafe(ts.turnId),
                itemId: RuntimeItemId.makeUnsafe(update.toolCallId),
                type: "item.completed" as const,
                payload: {
                  itemType,
                  status: "completed" as const,
                  title: titleForItemType(itemType),
                  ...(update.rawOutput ? { data: update.rawOutput } : {}),
                },
              });
            } else if (update.status === "in_progress") {
              const stamp = yield* makeEventStamp();
              yield* offerEvent({
                ...makeV2Base(context, stamp),
                turnId: TurnId.makeUnsafe(ts.turnId),
                itemId: RuntimeItemId.makeUnsafe(update.toolCallId),
                type: "item.updated" as const,
                payload: {
                  itemType: "dynamic_tool_call" as const,
                  status: "inProgress" as const,
                },
              });
            }
            return;
          }

          case "available_commands_update":
            return;

          default:
            return;
        }
      });

    const handleServerRequest = (
      context: CursorSessionContext,
      msg: AcpJsonRpcMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (msg.method !== "session/request_permission" || msg.id === undefined) return;

        const params = msg.params as {
          sessionId?: string;
          toolCall?: { toolCallId?: string; title?: string; kind?: string };
          options?: ReadonlyArray<{ optionId: string; name: string }>;
        } | undefined;

        const toolCallId = params?.toolCall?.toolCallId ?? `unknown-${msg.id}`;
        const requestType = classifyPermissionRequestType(params?.toolCall?.kind);
        const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);

        const pending: PendingPermission = {
          jsonRpcId: msg.id,
          requestId,
          requestType,
          toolCallId,
        };
        context.pendingPermissions.set(requestId, pending);

        const title = params?.toolCall?.title ?? "Permission requested";
        const stamp = yield* makeEventStamp();
        yield* offerEvent({
          ...makeV2Base(context, stamp),
          ...(context.turnState
            ? { turnId: TurnId.makeUnsafe(context.turnState.turnId) }
            : {}),
          requestId: RuntimeRequestId.makeUnsafe(requestId),
          type: "request.opened" as const,
          payload: {
            requestType,
            detail: title,
            args: params,
          },
        });
      });

    const handleStdoutLine = (
      context: CursorSessionContext,
      line: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const msg = safeParse(line);
        if (!msg) return;

        nativeEventLogger?.write({
          observedAt: new Date().toISOString(),
          event: {
            direction: "server->client",
            provider: PROVIDER,
            sessionId: context.session.sessionId,
            message: msg,
          },
        });

        const hasId = msg.id !== undefined;
        const hasMethod = typeof msg.method === "string";
        const hasResult = "result" in msg;
        const hasError = "error" in msg;

        if (hasId && (hasResult || hasError) && !hasMethod) {
          if (hasError) {
            rejectRpcRequest(context, msg.id!, msg.error);
          } else {
            resolveRpcRequest(context, msg.id!, msg.result);
          }
          return;
        }

        if (hasId && hasMethod) {
          yield* handleServerRequest(context, msg);
          return;
        }

        if (hasMethod && !hasId) {
          if (msg.method === "session/update") {
            const params = msg.params as { update?: AcpSessionUpdate } | undefined;
            if (params?.update) {
              yield* handleSessionUpdate(context, params.update);
            }
          }
          return;
        }
      });

    const startStdoutReader = (context: CursorSessionContext): void => {
      const rl = readline.createInterface({ input: context.child.stdout! });
      rl.on("line", (line) => {
        Effect.runFork(
          handleStdoutLine(context, line).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause) || context.stopped) return Effect.void;
              return Effect.logWarning("ACP stdout line handling failed", {
                cause: Cause.pretty(cause),
              });
            }),
          ),
        );
      });
      rl.on("close", () => {
        // stdout closed - process likely exiting
      });
    };

    const spawnAcpProcess = (binaryPath?: string): ChildProcess => {
      const bin = binaryPath ?? options?.binaryPath ?? ACP_BINARY;
      return spawn(bin, ACP_ARGS, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1" },
      });
    };

    const initializeAcp = (
      context: CursorSessionContext,
    ): Effect.Effect<unknown, ProviderAdapterError> =>
      rpcRequest(context, "initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "t3-cursor-adapter", version: "1.0.0" },
      });

    const authenticateAcp = (
      context: CursorSessionContext,
      methodId: string,
    ): Effect.Effect<unknown, ProviderAdapterError> =>
      rpcRequest(context, "authenticate", { methodId }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const stamp = yield* makeEventStamp();
            yield* offerEvent({
              ...makeV2Base(context, stamp),
              type: "runtime.warning" as const,
              payload: {
                message: `Authentication warning: ${toMessage(error, "authenticate failed")}`,
              },
            });
            return {};
          }),
        ),
      );

    const createAcpSession = (
      context: CursorSessionContext,
      cwd: string,
      model?: string,
    ): Effect.Effect<string, ProviderAdapterError> =>
      Effect.gen(function* () {
        const result = (yield* rpcRequest(context, "session/new", {
          cwd,
          mcpServers: [],
          ...(model ? { model } : {}),
        })) as { sessionId?: string; modes?: unknown };

        if (!result.sessionId || typeof result.sessionId !== "string") {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            sessionId: context.session.sessionId,
            detail: "session/new did not return a sessionId.",
          });
        }

        return result.sessionId;
      });

    const loadAcpSession = (
      context: CursorSessionContext,
      acpSessionId: string,
      cwd: string,
    ): Effect.Effect<void, ProviderAdapterError> =>
      rpcRequest(context, "session/load", {
        sessionId: acpSessionId,
        cwd,
        mcpServers: [],
      }).pipe(Effect.asVoid);

    const stopSessionInternal = (
      context: CursorSessionContext,
      opts?: { readonly emitExitEvent?: boolean },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;

        for (const [key, pending] of context.pendingPermissions) {
          rpcRespond(context, pending.jsonRpcId, {
            outcome: { outcome: "selected", optionId: "reject-once" },
          });
          const stamp = yield* makeEventStamp();
          yield* offerEvent({
            ...makeV2Base(context, stamp),
            requestId: RuntimeRequestId.makeUnsafe(pending.requestId),
            type: "request.resolved" as const,
            payload: {
              requestType: pending.requestType,
              decision: "cancel",
            },
          });
          context.pendingPermissions.delete(key);
        }

        if (context.turnState) {
          const stamp = yield* makeEventStamp();
          yield* offerEvent({
            ...makeV2Base(context, stamp),
            turnId: TurnId.makeUnsafe(context.turnState.turnId),
            type: "turn.completed" as const,
            payload: {
              state: "interrupted" as const,
              errorMessage: "Session stopped.",
            },
          });
          context.turnState = undefined;
        }

        for (const [id, pending] of context.pendingRpc) {
          clearTimeout(pending.timer);
          Effect.runFork(
            Deferred.fail(
              pending.deferred,
              new ProviderAdapterSessionClosedError({
                provider: PROVIDER,
                sessionId: context.session.sessionId,
              }),
            ),
          );
          context.pendingRpc.delete(id);
        }

        yield* Effect.sync(() => {
          try {
            context.child.stdin!.end();
          } catch { /* best-effort */ }
          context.child.kill("SIGTERM");
        });

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt,
        };

        if (opts?.emitExitEvent !== false) {
          const stamp = yield* makeEventStamp();
          yield* offerEvent({
            ...makeV2Base(context, stamp),
            type: "session.exited" as const,
            payload: {
              reason: "Session stopped",
              exitKind: "graceful" as const,
            },
          });
        }

        sessions.delete(context.session.sessionId);
      });

    const requireSession = (
      sessionId: ProviderSessionId,
    ): Effect.Effect<CursorSessionContext, ProviderAdapterError> => {
      const context = sessions.get(sessionId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, sessionId }),
        );
      }
      if (context.stopped || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({ provider: PROVIDER, sessionId }),
        );
      }
      return Effect.succeed(context);
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

        const startedAt = yield* nowIso;
        const sessionId = ProviderSessionId.makeUnsafe(
          `cursor-session-${yield* Random.nextUUIDv4}`,
        );
        const cursorOptions = input.providerOptions?.cursor;
        const cwd = input.cwd ?? process.cwd();

        const child = spawnAcpProcess(cursorOptions?.binaryPath);

        const session: ProviderSession = {
          sessionId,
          provider: PROVIDER,
          status: "connecting",
          cwd,
          ...(input.model ? { model: input.model } : {}),
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        const context: CursorSessionContext = {
          session,
          acpSessionId: "",
          child,
          nextRpcId: 1,
          pendingRpc: new Map(),
          pendingPermissions: new Map(),
          turnState: undefined,
          stopped: false,
        };
        sessions.set(sessionId, context);

        child.once("exit", (code, signal) => {
          if (context.stopped) return;
          Effect.runFork(
            Effect.gen(function* () {
              const msg = `ACP process exited (code=${String(code)}, signal=${String(signal)})`;
              const stamp = yield* makeEventStamp();
              yield* offerEvent({
                ...makeV2Base(context, stamp),
                type: "runtime.error" as const,
                payload: { message: msg, class: "transport_error" as const },
              });
              yield* stopSessionInternal(context, { emitExitEvent: true });
            }),
          );
        });

        startStdoutReader(context);

        yield* initializeAcp(context);
        const authMethodId = cursorOptions?.authMethodId ?? "cursor_login";
        yield* authenticateAcp(context, authMethodId);

        const existingCursor = input.resumeCursor as
          | { acpSessionId?: string }
          | undefined;
        let acpSessionId: string;

        if (existingCursor?.acpSessionId) {
          yield* loadAcpSession(context, existingCursor.acpSessionId, cwd);
          acpSessionId = existingCursor.acpSessionId;
        } else {
          acpSessionId = yield* createAcpSession(context, cwd, input.model);
        }

        context.acpSessionId = acpSessionId;
        const threadId = ProviderThreadId.makeUnsafe(acpSessionId);

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "ready",
          threadId,
          resumeCursor: { acpSessionId },
          updatedAt,
        };

        const sessionStartedStamp = yield* makeEventStamp();
        yield* offerEvent({
          ...makeV2Base(context, sessionStartedStamp),
          type: "session.started" as const,
          payload: {},
        });

        const threadStartedStamp = yield* makeEventStamp();
        yield* offerEvent({
          ...makeV2Base(context, threadStartedStamp),
          threadId: ThreadId.makeUnsafe(threadId),
          type: "thread.started" as const,
          payload: { providerThreadId: threadId },
        });

        return { ...context.session };
      });

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.sessionId);

        if (context.turnState) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Session '${input.sessionId}' already has an active turn.`,
          });
        }

        const turnId = ProviderTurnId.makeUnsafe(`cursor-turn-${yield* Random.nextUUIDv4}`);

        const turnState: CursorTurnState = {
          turnId,
          assistantItemId: `cursor-message-${yield* Random.nextUUIDv4}`,
          startedAt: yield* nowIso,
          seenToolCallIds: new Set(),
          emittedAssistantDelta: false,
        };

        context.turnState = turnState;
        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt,
        };

        const turnStartedStamp = yield* makeEventStamp();
        yield* offerEvent({
          ...makeV2Base(context, turnStartedStamp),
          turnId: TurnId.makeUnsafe(turnId),
          type: "turn.started" as const,
          payload: {
            ...(input.model ? { model: input.model } : {}),
          },
        });

        const promptParts: Array<{ type: string; text: string }> = [];
        if (input.input) {
          promptParts.push({ type: "text", text: input.input });
        }

        Effect.runFork(
          Effect.gen(function* () {
            const result = yield* rpcRequest(context, "session/prompt", {
              sessionId: context.acpSessionId,
              prompt: promptParts,
            }).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  const stamp = yield* makeEventStamp();
                  yield* offerEvent({
                    ...makeV2Base(context, stamp),
                    turnId: TurnId.makeUnsafe(turnId),
                    type: "runtime.error" as const,
                    payload: {
                      message: toMessage(error, "Prompt failed"),
                      class: "provider_error" as const,
                    },
                  });
                  return { stopReason: "error" } as { stopReason?: string };
                }),
              ),
            );

            const promptResult = result as { stopReason?: string };

            if (context.turnState?.emittedAssistantDelta) {
              const msgStamp = yield* makeEventStamp();
              yield* offerEvent({
                ...makeV2Base(context, msgStamp),
                turnId: TurnId.makeUnsafe(turnId),
                itemId: RuntimeItemId.makeUnsafe(turnState.assistantItemId),
                type: "item.completed" as const,
                payload: {
                  itemType: "assistant_message" as const,
                  status: "completed" as const,
                },
              });
            }

            const state: "completed" | "failed" | "cancelled" =
              promptResult.stopReason === "cancelled"
                ? "cancelled"
                : promptResult.stopReason === "error"
                  ? "failed"
                  : "completed";

            const completedStamp = yield* makeEventStamp();
            yield* offerEvent({
              ...makeV2Base(context, completedStamp),
              turnId: TurnId.makeUnsafe(turnId),
              type: "turn.completed" as const,
              payload: {
                state,
                ...(promptResult.stopReason ? { stopReason: promptResult.stopReason } : {}),
              },
            });

            context.turnState = undefined;
            const doneAt = yield* nowIso;
            context.session = {
              ...context.session,
              status: "ready",
              activeTurnId: undefined,
              updatedAt: doneAt,
            };
          }),
        );

        return {
          threadId: context.session.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        };
      });

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (sessionId, _turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);

        if (!context.turnState) return;

        const turnId = context.turnState.turnId;
        context.stopped = true;
        context.child.kill("SIGTERM");

        const stamp = yield* makeEventStamp();
        yield* offerEvent({
          ...makeV2Base(context, stamp),
          turnId: TurnId.makeUnsafe(turnId),
          type: "turn.completed" as const,
          payload: {
            state: "interrupted" as const,
            errorMessage: "Turn interrupted by user.",
          },
        });

        context.turnState = undefined;
        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt,
        };
      });

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
      sessionId,
      requestId,
      decision,
    ) =>
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

        context.pendingPermissions.delete(requestId);

        const optionId =
          decision === "accept"
            ? "allow-once"
            : decision === "acceptForSession"
              ? "allow-always"
              : "reject-once";

        rpcRespond(context, pending.jsonRpcId, {
          outcome: { outcome: "selected", optionId },
        });

        const stamp = yield* makeEventStamp();
        yield* offerEvent({
          ...makeV2Base(context, stamp),
          ...(context.turnState
            ? { turnId: TurnId.makeUnsafe(context.turnState.turnId) }
            : {}),
          requestId: RuntimeRequestId.makeUnsafe(requestId),
          type: "request.resolved" as const,
          payload: {
            requestType: pending.requestType,
            decision,
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
        return { threadId, turns: [] };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (_sessionId, _numTurns) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Cursor ACP does not support thread rollback.",
        }),
      );

    const stopSession: CursorAdapterShape["stopSession"] = (sessionId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        yield* stopSessionInternal(context, { emitExitEvent: true });
      });

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: CursorAdapterShape["hasSession"] = (sessionId) =>
      Effect.sync(() => {
        const context = sessions.get(sessionId);
        return context !== undefined && !context.stopped;
      });

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.forEach(
        Array.from(sessions.values()),
        (context) => stopSessionInternal(context, { emitExitEvent: true }),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        Array.from(sessions.values()),
        (context) => stopSessionInternal(context, { emitExitEvent: false }),
        { discard: true },
      ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
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
}

export const CursorAdapterLive = Layer.effect(CursorAdapter, makeCursorAdapter());

export function makeCursorAdapterLive(options?: CursorAdapterLiveOptions) {
  return Layer.effect(CursorAdapter, makeCursorAdapter(options));
}
