/**
 * CursorAdapter - Cursor ACP (`agent acp`) implementation of the generic provider adapter contract.
 *
 * This service owns Cursor ACP process / JSON-RPC 2.0 semantics and emits
 * canonical provider runtime events via the shared provider adapter contract.
 *
 * ACP schemas for decode/validation of JSON-RPC messages are defined here so
 * the layer implementation can validate protocol boundary in a single place.
 *
 * @module CursorAdapter
 */
import { Schema, ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export const AcpSessionId = Schema.String.check(Schema.isNonEmpty());
export type AcpSessionId = typeof AcpSessionId.Type;

export const AcpTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type AcpTextContent = typeof AcpTextContent.Type;

export const AcpSessionMode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
});
export type AcpSessionMode = typeof AcpSessionMode.Type;

export const AcpSessionModes = Schema.Struct({
  currentModeId: Schema.String,
  availableModes: Schema.Array(AcpSessionMode),
});
export type AcpSessionModes = typeof AcpSessionModes.Type;

export const AcpInitializeResult = Schema.Struct({
  protocolVersion: Schema.Number,
  agentCapabilities: Schema.optional(Schema.Unknown),
  authMethods: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type AcpInitializeResult = typeof AcpInitializeResult.Type;

export const AcpSessionNewResult = Schema.Struct({
  sessionId: AcpSessionId,
  modes: Schema.optional(AcpSessionModes),
});
export type AcpSessionNewResult = typeof AcpSessionNewResult.Type;

export const AcpPromptResult = Schema.Struct({
  stopReason: Schema.optional(Schema.String),
});
export type AcpPromptResult = typeof AcpPromptResult.Type;

export const AcpPermissionOption = Schema.Struct({
  optionId: Schema.String,
  name: Schema.String,
  kind: Schema.optional(Schema.String),
});
export type AcpPermissionOption = typeof AcpPermissionOption.Type;

export const AcpPermissionToolCall = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type AcpPermissionToolCall = typeof AcpPermissionToolCall.Type;

export const AcpPermissionRequestParams = Schema.Struct({
  sessionId: AcpSessionId,
  toolCall: AcpPermissionToolCall,
  options: Schema.Array(AcpPermissionOption),
});
export type AcpPermissionRequestParams = typeof AcpPermissionRequestParams.Type;

export type AcpSessionUpdateType =
  | "available_commands_update"
  | "agent_thought_chunk"
  | "agent_message_chunk"
  | "tool_call"
  | "tool_call_update";

export interface AcpSessionUpdate {
  readonly sessionUpdate: AcpSessionUpdateType | string;
  readonly content?: { type: string; text: string };
  readonly toolCallId?: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly availableCommands?: ReadonlyArray<{ name: string; description: string }>;
}

export interface AcpJsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

export interface CursorAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "cursor";
}

export class CursorAdapter extends ServiceMap.Service<CursorAdapter, CursorAdapterShape>()(
  "t3/provider/Services/CursorAdapter",
) {}
