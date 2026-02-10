import type { CanonicalSessionState, ProviderRawEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { ProviderEventNormalizer } from "./providerEventNormalizer";

function makeRawEvent(overrides: Partial<ProviderRawEvent> = {}): ProviderRawEvent {
  return {
    id: "raw-1",
    kind: "notification",
    provider: "codex",
    sessionId: "sess-1",
    createdAt: "2026-02-10T00:00:00.000Z",
    method: "turn/started",
    payload: {
      thread: { id: "thread-1" },
      turn: { id: "turn-1" },
    },
    ...overrides,
  };
}

function makeSession(overrides: Partial<CanonicalSessionState> = {}): CanonicalSessionState {
  return {
    sessionId: "sess-1",
    provider: "codex",
    status: "ready",
    createdAt: "2026-02-10T00:00:00.000Z",
    updatedAt: "2026-02-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("ProviderEventNormalizer", () => {
  it("maps turn start notifications to canonical session and turn events", () => {
    const normalizer = new ProviderEventNormalizer();

    const normalized = normalizer.normalize(
      makeRawEvent({
        method: "turn/started",
      }),
      makeSession(),
    );

    expect(normalized).toHaveLength(2);
    expect(normalized[0]?.type).toBe("session.updated");
    expect(normalized[1]?.type).toBe("turn.started");
  });

  it("maps command approval requests and decision notifications", () => {
    const normalizer = new ProviderEventNormalizer();

    const requested = normalizer.normalize(
      makeRawEvent({
        kind: "request",
        method: "item/commandExecution/requestApproval",
        requestId: "approval-1",
        payload: {
          thread: { id: "thread-1" },
          turn: { id: "turn-1" },
          command: "git status --short",
        },
      }),
      makeSession(),
    );

    expect(requested.some((event) => event.type === "approval.requested")).toBe(true);

    const resolved = normalizer.normalize(
      makeRawEvent({
        kind: "notification",
        method: "item/requestApproval/decision",
        requestId: "approval-1",
        payload: {
          requestId: "approval-1",
          decision: "acceptForSession",
        },
      }),
      makeSession(),
    );

    const approvalResolved = resolved.find((event) => event.type === "approval.resolved");
    expect(approvalResolved).toBeDefined();
    if (!approvalResolved || approvalResolved.type !== "approval.resolved") {
      throw new Error("expected approval.resolved event");
    }
    expect(approvalResolved.decision).toBe("accept_for_session");
  });

  it("drops unmapped methods from the core stream", () => {
    const normalizer = new ProviderEventNormalizer();

    const normalized = normalizer.normalize(
      makeRawEvent({
        method: "item/reasoning/summaryPartAdded",
        payload: {
          text: "partial summary",
        },
      }),
      makeSession(),
    );

    expect(normalized).toHaveLength(0);
  });

  it("creates debug.raw wrappers", () => {
    const normalizer = new ProviderEventNormalizer();
    const raw = makeRawEvent({ method: "item/reasoning/summaryPartAdded" });

    const debug = normalizer.toDebugRaw(raw);

    expect(debug.type).toBe("debug.raw");
    if (debug.type !== "debug.raw") {
      throw new Error("expected debug.raw event");
    }
    expect(debug.provider).toBe("codex");
    expect(debug.method).toBe("item/reasoning/summaryPartAdded");
  });
});
