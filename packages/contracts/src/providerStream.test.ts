import { describe, expect, it } from "vitest";

import {
  providerCoreEventSchema,
  providerStreamFrameSchema,
  providersOpenStreamInputSchema,
  providersOpenStreamResultSchema,
} from "./providerStream";

describe("providersOpenStreamInputSchema", () => {
  it("accepts optional cursor and filters", () => {
    const parsed = providersOpenStreamInputSchema.parse({
      afterSeq: 42,
      sessionIds: ["sess_1"],
      eventKinds: ["message", "turn"],
      includeExtensions: ["codex.turn.plan"],
      includeDebugRaw: true,
    });
    expect(parsed.afterSeq).toBe(42);
    expect(parsed.sessionIds).toEqual(["sess_1"]);
  });
});

describe("providerCoreEventSchema", () => {
  it("accepts message delta events", () => {
    const parsed = providerCoreEventSchema.parse({
      type: "message.delta",
      sessionId: "sess_1",
      threadId: "thr_1",
      turnId: "turn_1",
      messageId: "msg_1",
      role: "assistant",
      delta: "hello",
    });
    expect(parsed.type).toBe("message.delta");
  });

  it("accepts approval events with snake-case decisions", () => {
    const parsed = providerCoreEventSchema.parse({
      type: "approval.resolved",
      sessionId: "sess_1",
      approvalId: "approval_1",
      decision: "accept_for_session",
      resolvedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.type).toBe("approval.resolved");
    if (parsed.type !== "approval.resolved") {
      throw new Error("unexpected event variant");
    }
    expect(parsed.decision).toBe("accept_for_session");
  });
});

describe("providerStreamFrameSchema", () => {
  it("accepts snapshot frames", () => {
    const parsed = providerStreamFrameSchema.parse({
      kind: "snapshot",
      seq: 100,
      at: "2026-01-01T00:00:00.000Z",
      data: {
        sessions: [],
        activeTurns: [],
        activeMessages: [],
        pendingApprovals: [],
      },
    });
    expect(parsed.kind).toBe("snapshot");
  });

  it("accepts open stream result payloads", () => {
    const parsed = providersOpenStreamResultSchema.parse({
      mode: "replay",
      currentSeq: 200,
      oldestSeq: 150,
      replayedCount: 10,
    });
    expect(parsed.mode).toBe("replay");
  });
});
