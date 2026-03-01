import { describe, it, expect } from "vitest";

import { AcpInitializeResult, AcpSessionNewResult, AcpPermissionRequestParams } from "./CursorAdapter.ts";
import { Schema } from "effect";

describe("CursorAdapter ACP schemas", () => {
  it("decodes AcpInitializeResult", () => {
    const decoded = Schema.decodeUnknownSync(AcpInitializeResult)({
      protocolVersion: 1,
    });
    expect(decoded.protocolVersion).toBe(1);
  });

  it("decodes AcpSessionNewResult", () => {
    const decoded = Schema.decodeUnknownSync(AcpSessionNewResult)({
      sessionId: "sess-1",
    });
    expect(decoded.sessionId).toBe("sess-1");
  });

  it("decodes AcpPermissionRequestParams", () => {
    const decoded = Schema.decodeUnknownSync(AcpPermissionRequestParams)({
      sessionId: "sess-1",
      toolCall: {
        toolCallId: "tc-1",
        title: "Run command",
        kind: "shell",
        status: "pending",
      },
      options: [{ optionId: "allow", name: "Allow", kind: "accept" }],
    });
    expect(decoded.sessionId).toBe("sess-1");
    expect(decoded.toolCall.toolCallId).toBe("tc-1");
    expect(decoded.options).toHaveLength(1);
  });
});
