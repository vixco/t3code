/**
 * CursorAdapter - Cursor ACP implementation of the generic provider adapter contract.
 *
 * This service owns Cursor ACP (`agent acp`) JSON-RPC stream semantics and emits
 * canonical provider runtime events via the shared provider adapter contract.
 *
 * This file defines ACP transport envelopes and high-signal payload schemas used by
 * the live layer implementation for safe boundary decoding.
 *
 * @module CursorAdapter
 */
import { Schema, ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export const CursorAcpJsonRpcId = Schema.Union([Schema.String, Schema.Number]);
export type CursorAcpJsonRpcId = typeof CursorAcpJsonRpcId.Type;

export const CursorAcpError = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});
export type CursorAcpError = typeof CursorAcpError.Type;

export const CursorAcpResponseEnvelope = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: CursorAcpJsonRpcId,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(CursorAcpError),
});
export type CursorAcpResponseEnvelope = typeof CursorAcpResponseEnvelope.Type;

export const CursorAcpRequestEnvelope = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: CursorAcpJsonRpcId,
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
export type CursorAcpRequestEnvelope = typeof CursorAcpRequestEnvelope.Type;

export const CursorAcpNotificationEnvelope = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
export type CursorAcpNotificationEnvelope = typeof CursorAcpNotificationEnvelope.Type;

export const CursorAcpInitializeResult = Schema.Struct({
  protocolVersion: Schema.Unknown,
  agentCapabilities: Schema.optional(Schema.Unknown),
  authMethods: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type CursorAcpInitializeResult = typeof CursorAcpInitializeResult.Type;

export const CursorAcpSessionResult = Schema.Struct({
  sessionId: Schema.String.check(Schema.isNonEmpty()),
  modes: Schema.optional(Schema.Array(Schema.String)),
});
export type CursorAcpSessionResult = typeof CursorAcpSessionResult.Type;

export const CursorAcpPromptResult = Schema.Struct({
  stopReason: Schema.String,
});
export type CursorAcpPromptResult = typeof CursorAcpPromptResult.Type;

export const CursorAcpTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type CursorAcpTextContent = typeof CursorAcpTextContent.Type;

export const CursorAcpSessionUpdateAvailableCommands = Schema.Struct({
  sessionUpdate: Schema.Literal("available_commands_update"),
  availableCommands: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type CursorAcpSessionUpdateAvailableCommands =
  typeof CursorAcpSessionUpdateAvailableCommands.Type;

export const CursorAcpSessionUpdateThoughtChunk = Schema.Struct({
  sessionUpdate: Schema.Literal("agent_thought_chunk"),
  content: Schema.optional(CursorAcpTextContent),
});
export type CursorAcpSessionUpdateThoughtChunk = typeof CursorAcpSessionUpdateThoughtChunk.Type;

export const CursorAcpSessionUpdateMessageChunk = Schema.Struct({
  sessionUpdate: Schema.Literal("agent_message_chunk"),
  content: Schema.optional(CursorAcpTextContent),
});
export type CursorAcpSessionUpdateMessageChunk = typeof CursorAcpSessionUpdateMessageChunk.Type;

export const CursorAcpSessionUpdateToolCall = Schema.Struct({
  sessionUpdate: Schema.Literal("tool_call"),
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  rawInput: Schema.optional(Schema.Unknown),
});
export type CursorAcpSessionUpdateToolCall = typeof CursorAcpSessionUpdateToolCall.Type;

export const CursorAcpSessionUpdateToolCallUpdate = Schema.Struct({
  sessionUpdate: Schema.Literal("tool_call_update"),
  toolCallId: Schema.String,
  status: Schema.String,
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  rawInput: Schema.optional(Schema.Unknown),
  rawOutput: Schema.optional(Schema.Unknown),
});
export type CursorAcpSessionUpdateToolCallUpdate =
  typeof CursorAcpSessionUpdateToolCallUpdate.Type;

export const CursorAcpSessionUpdate = Schema.Union([
  CursorAcpSessionUpdateAvailableCommands,
  CursorAcpSessionUpdateThoughtChunk,
  CursorAcpSessionUpdateMessageChunk,
  CursorAcpSessionUpdateToolCall,
  CursorAcpSessionUpdateToolCallUpdate,
]);
export type CursorAcpSessionUpdate = typeof CursorAcpSessionUpdate.Type;

export const CursorAcpSessionUpdateNotification = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.Literal("session/update"),
  params: Schema.Struct({
    sessionId: Schema.String,
    update: CursorAcpSessionUpdate,
  }),
});
export type CursorAcpSessionUpdateNotification = typeof CursorAcpSessionUpdateNotification.Type;

export const CursorAcpPermissionOption = Schema.Struct({
  optionId: Schema.String,
  title: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});
export type CursorAcpPermissionOption = typeof CursorAcpPermissionOption.Type;

export const CursorAcpPermissionRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: CursorAcpJsonRpcId,
  method: Schema.Literal("session/request_permission"),
  params: Schema.Struct({
    sessionId: Schema.String,
    toolCall: Schema.optional(Schema.Unknown),
    options: Schema.Array(CursorAcpPermissionOption),
  }),
});
export type CursorAcpPermissionRequest = typeof CursorAcpPermissionRequest.Type;

/**
 * CursorAdapterShape - Service API for the Cursor provider adapter.
 *
 * `provider` is intentionally narrowed to `"cursor"` here. Until contracts add
 * Cursor to `ProviderKind`, this shape is defined via `Omit<...,"provider">`.
 */
export interface CursorAdapterShape
  extends Omit<ProviderAdapterShape<ProviderAdapterError>, "provider"> {
  readonly provider: "cursor";
}

/**
 * CursorAdapter - Service tag for Cursor provider adapter operations.
 */
export class CursorAdapter extends ServiceMap.Service<CursorAdapter, CursorAdapterShape>()(
  "t3/provider/Services/CursorAdapter",
) {}
