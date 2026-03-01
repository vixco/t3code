import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CursorAcpPermissionRequest,
  CursorAcpResponseEnvelope,
  CursorAcpSessionUpdate,
  CursorAcpSessionUpdateNotification,
} from "./CursorAdapter.ts";

describe("Cursor ACP schemas", () => {
  it("decodes session/update thought chunk notifications", () => {
    const decoded = Schema.decodeUnknownSync(CursorAcpSessionUpdateNotification)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            type: "text",
            text: "thinking...",
          },
        },
      },
    });

    expect(decoded.method).toBe("session/update");
    expect(decoded.params.update.sessionUpdate).toBe("agent_thought_chunk");
  });

  it("decodes tool_call_update completion payloads", () => {
    const decoded = Schema.decodeUnknownSync(CursorAcpSessionUpdate)({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      title: "Terminal",
      rawOutput: {
        exitCode: 0,
        stdout: "/workspace\n",
      },
    });

    expect(decoded.sessionUpdate).toBe("tool_call_update");
    if (decoded.sessionUpdate !== "tool_call_update") {
      return;
    }
    expect(decoded.toolCallId).toBe("tool-1");
    expect(decoded.status).toBe("completed");
  });

  it("decodes permission requests with options", () => {
    const decoded = Schema.decodeUnknownSync(CursorAcpPermissionRequest)({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: {
        sessionId: "sess-1",
        toolCall: {
          kind: "execute",
          command: "pwd",
        },
        options: [
          { optionId: "allow-once", title: "Allow once" },
          { optionId: "allow-always", title: "Always allow" },
          { optionId: "reject-once", title: "Reject" },
        ],
      },
    });

    expect(decoded.method).toBe("session/request_permission");
    expect(decoded.params.options).toHaveLength(3);
  });

  it("decodes json-rpc response envelopes", () => {
    const success = Schema.decodeUnknownSync(CursorAcpResponseEnvelope)({
      jsonrpc: "2.0",
      id: 1,
      result: { stopReason: "end_turn" },
    });
    expect(success.id).toBe(1);
    expect(success.result).toEqual({ stopReason: "end_turn" });

    const error = Schema.decodeUnknownSync(CursorAcpResponseEnvelope)({
      jsonrpc: "2.0",
      id: "2",
      error: {
        code: -32601,
        message: "Method not found",
      },
    });
    expect(error.id).toBe("2");
    expect(error.error?.code).toBe(-32601);
  });

  it("rejects unsupported session update kinds", () => {
    expect(() =>
      Schema.decodeUnknownSync(CursorAcpSessionUpdate)({
        sessionUpdate: "unknown_update_type",
      }),
    ).toThrow();
  });
});
