import type { CanonicalSessionState } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  PROVIDER_STREAM_MAX_REPLAY_EVENTS,
  ProviderStreamStore,
  providerStreamEventKindOf,
} from "./providerStreamStore";

function makeSessionState(overrides: Partial<CanonicalSessionState> = {}): CanonicalSessionState {
  return {
    sessionId: "sess-1",
    provider: "codex",
    status: "ready",
    createdAt: "2026-02-10T00:00:00.000Z",
    updatedAt: "2026-02-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("ProviderStreamStore", () => {
  it("stores events in seq order and builds snapshot state", () => {
    const store = new ProviderStreamStore();
    const baseMs = Date.now();
    const at = (offsetSeconds: number) => new Date(baseMs + offsetSeconds * 1_000).toISOString();

    store.appendEvent(
      {
        type: "session.updated",
        session: makeSessionState(),
      },
      at(0),
    );

    store.appendEvent(
      {
        type: "turn.started",
        sessionId: "sess-1",
        threadId: "thread-1",
        turnId: "turn-1",
        startedAt: at(1),
      },
      at(1),
    );

    store.appendEvent(
      {
        type: "message.delta",
        sessionId: "sess-1",
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "msg-1",
        role: "assistant",
        delta: "Hello",
      },
      at(2),
    );

    store.appendEvent(
      {
        type: "approval.requested",
        sessionId: "sess-1",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        approvalKind: "command",
        title: "Command approval requested",
        requestedAt: at(3),
      },
      at(3),
    );

    const snapshot = store.getSnapshot();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.activeTurns).toHaveLength(1);
    expect(snapshot.activeMessages).toHaveLength(1);
    expect(snapshot.pendingApprovals).toHaveLength(1);

    const replay = store.selectReplay(1, 10);
    expect(replay.ok).toBe(true);
    if (!replay.ok) {
      throw new Error("expected replay selection");
    }
    expect(replay.events.map((entry) => entry.seq)).toEqual([2, 3, 4]);
  });

  it("returns cursor_ahead and replay_limit_exceeded when needed", () => {
    const store = new ProviderStreamStore();
    const baseMs = Date.now();
    for (let i = 0; i < 20; i += 1) {
      store.appendEvent(
        {
          type: "error",
          sessionId: "sess-1",
          code: "runtime/error",
          message: `err-${i}`,
        },
        new Date(baseMs + i * 1_000).toISOString(),
      );
    }

    const ahead = store.selectReplay(30, 10);
    expect(ahead.ok).toBe(false);
    if (ahead.ok) {
      throw new Error("expected gap selection");
    }
    expect(ahead.reason).toBe("cursor_ahead");

    const overLimit = store.selectReplay(0, 10);
    expect(overLimit.ok).toBe(false);
    if (overLimit.ok) {
      throw new Error("expected replay_limit_exceeded");
    }
    expect(overLimit.reason).toBe("replay_limit_exceeded");
  });

  it("evicts old events and reports cursor_too_old", () => {
    const store = new ProviderStreamStore();

    for (let i = 0; i < PROVIDER_STREAM_MAX_REPLAY_EVENTS + 10; i += 1) {
      store.appendEvent(
        {
          type: "error",
          sessionId: "sess-1",
          code: "runtime/error",
          message: `err-${i}`,
        },
        "2026-02-10T00:00:00.000Z",
      );
    }

    const oldestSeq = store.oldestSeq;
    expect(oldestSeq).toBeGreaterThan(1);

    const stale = store.selectReplay(Math.max(0, oldestSeq - 2), 100);
    expect(stale.ok).toBe(false);
    if (stale.ok) {
      throw new Error("expected cursor_too_old");
    }
    expect(stale.reason).toBe("cursor_too_old");
  });

  it("filters snapshot by session id", () => {
    const store = new ProviderStreamStore();

    store.appendEvent({
      type: "session.updated",
      session: makeSessionState({ sessionId: "sess-a" }),
    });
    store.appendEvent({
      type: "session.updated",
      session: makeSessionState({ sessionId: "sess-b" }),
    });

    const filtered = store.getSnapshot(new Set(["sess-a"]));
    expect(filtered.sessions).toHaveLength(1);
    expect(filtered.sessions[0]?.sessionId).toBe("sess-a");
  });

  it("classifies provider stream event kinds", () => {
    expect(
      providerStreamEventKindOf({
        type: "message.delta",
        sessionId: "sess-1",
        threadId: "thread-1",
        messageId: "msg-1",
        role: "assistant",
        delta: "x",
      }),
    ).toBe("message");

    expect(
      providerStreamEventKindOf({
        type: "debug.raw",
        provider: "codex",
        method: "thread/started",
        payload: null,
      }),
    ).toBe("debug.raw");
  });
});
