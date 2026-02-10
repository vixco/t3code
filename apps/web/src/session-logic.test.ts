import { describe, expect, it } from "vitest";

import type { ProviderCoreEvent, ProviderSession } from "@t3tools/contracts";
import {
  type WorkLogEntry,
  applyEventToMessages,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  evolveSession,
} from "./session-logic";
import type { ChatMessage, ThreadEvent } from "./types";

function makeEventRecord(
  event: ProviderCoreEvent,
  overrides: Partial<ThreadEvent> = {},
): ThreadEvent {
  return {
    seq: overrides.seq ?? 1,
    at: overrides.at ?? "2026-02-08T10:00:00.000Z",
    event,
  };
}

function makeSession(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    sessionId: "sess-1",
    provider: "codex",
    status: "ready",
    createdAt: "2026-02-08T09:59:00.000Z",
    updatedAt: "2026-02-08T09:59:00.000Z",
    ...overrides,
  };
}

describe("deriveTimelineEntries", () => {
  it("interleaves messages and work entries by timestamp", () => {
    const messages: ChatMessage[] = [
      {
        id: "m-user",
        role: "user",
        text: "Hi",
        createdAt: "2026-02-08T10:00:00.000Z",
        streaming: false,
      },
      {
        id: "m-assistant",
        role: "assistant",
        text: "Hello",
        createdAt: "2026-02-08T10:05:00.000Z",
        streaming: false,
      },
    ];
    const workEntries: WorkLogEntry[] = [
      {
        id: "w-1",
        label: "Tool call",
        createdAt: "2026-02-08T10:02:00.000Z",
        tone: "tool",
      },
      {
        id: "w-2",
        label: "Plan updated",
        createdAt: "2026-02-08T10:03:00.000Z",
        tone: "thinking",
      },
    ];

    const timeline = deriveTimelineEntries(messages, workEntries);

    expect(timeline.map((entry) => entry.id)).toEqual([
      "message:m-user",
      "work:w-1",
      "work:w-2",
      "message:m-assistant",
    ]);
  });

  it("prefers work entries when timestamps are equal", () => {
    const messages: ChatMessage[] = [
      {
        id: "m-1",
        role: "assistant",
        text: "Done",
        createdAt: "2026-02-08T10:00:00.000Z",
        streaming: false,
      },
    ];
    const workEntries: WorkLogEntry[] = [
      {
        id: "w-1",
        label: "Tool call",
        createdAt: "2026-02-08T10:00:00.000Z",
        tone: "tool",
      },
    ];

    const timeline = deriveTimelineEntries(messages, workEntries);

    expect(timeline.map((entry) => entry.id)).toEqual(["work:w-1", "message:m-1"]);
  });
});

describe("deriveWorkLogEntries", () => {
  it("shows approvals, activities, and runtime errors", () => {
    const entries = deriveWorkLogEntries(
      [
        makeEventRecord(
          {
            type: "error",
            sessionId: "sess-1",
            threadId: "thread-1",
            turnId: "turn-1",
            code: "runtime/error",
            message: "sandbox denied",
          },
          { seq: 3, at: "2026-02-08T10:00:02.000Z" },
        ),
        makeEventRecord(
          {
            type: "activity",
            sessionId: "sess-1",
            threadId: "thread-1",
            turnId: "turn-1",
            activityId: "tool-1",
            activityKind: "tool",
            label: "Tool call",
            detail: "spawnAgent",
            status: "success",
            completedAt: "2026-02-08T10:00:01.000Z",
          },
          { seq: 2, at: "2026-02-08T10:00:01.000Z" },
        ),
        makeEventRecord({
          type: "approval.requested",
          sessionId: "sess-1",
          threadId: "thread-1",
          turnId: "turn-1",
          approvalId: "approval-1",
          approvalKind: "command",
          title: "Command approval requested",
          detail: "git status --short",
          requestedAt: "2026-02-08T10:00:00.000Z",
        }),
      ],
      "turn-1",
    );

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.label)).toEqual([
      "Command approval requested",
      "Tool call",
      "Runtime error",
    ]);
  });

  it("suppresses created activity rows when a completion exists", () => {
    const entries = deriveWorkLogEntries(
      [
        makeEventRecord({
          type: "activity",
          sessionId: "sess-1",
          threadId: "thread-1",
          turnId: "turn-1",
          activityId: "tool-1",
          activityKind: "tool",
          label: "Tool call",
          detail: "ls -la",
          status: "created",
          startedAt: "2026-02-08T10:00:00.000Z",
        }),
        makeEventRecord(
          {
            type: "activity",
            sessionId: "sess-1",
            threadId: "thread-1",
            turnId: "turn-1",
            activityId: "tool-1",
            activityKind: "tool",
            label: "Tool call",
            detail: "ls -la",
            status: "success",
            completedAt: "2026-02-08T10:00:01.000Z",
          },
          { seq: 2, at: "2026-02-08T10:00:01.000Z" },
        ),
      ],
      "turn-1",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toBe("ls -la");
  });

  it("shows failed turn completion", () => {
    const entries = deriveWorkLogEntries(
      [
        makeEventRecord({
          type: "turn.completed",
          sessionId: "sess-1",
          threadId: "thread-1",
          turnId: "turn-1",
          completedAt: "2026-02-08T10:00:10.000Z",
          outcome: "failed",
          error: "boom",
        }),
      ],
      "turn-1",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Turn failed");
    expect(entries[0]?.detail).toBe("boom");
  });
});

describe("evolveSession", () => {
  it("replaces session on session.updated", () => {
    const previous = makeSession();
    const next = evolveSession(
      previous,
      {
        type: "session.updated",
        session: {
          ...previous,
          status: "running",
          threadId: "thread-1",
          activeTurnId: "turn-1",
          updatedAt: "2026-02-08T10:00:00.000Z",
        },
      },
      "2026-02-08T10:00:00.000Z",
    );

    expect(next.status).toBe("running");
    expect(next.threadId).toBe("thread-1");
    expect(next.activeTurnId).toBe("turn-1");
  });

  it("moves to running on turn.started", () => {
    const previous = makeSession();
    const next = evolveSession(
      previous,
      {
        type: "turn.started",
        sessionId: "sess-1",
        threadId: "thread-1",
        turnId: "turn-1",
        startedAt: "2026-02-08T10:02:00.000Z",
      },
      "2026-02-08T10:02:00.000Z",
    );

    expect(next.status).toBe("running");
    expect(next.activeTurnId).toBe("turn-1");
  });

  it("returns to ready on successful completion", () => {
    const previous = makeSession({
      status: "running",
      activeTurnId: "turn-1",
    });
    const next = evolveSession(
      previous,
      {
        type: "turn.completed",
        sessionId: "sess-1",
        threadId: "thread-1",
        turnId: "turn-1",
        completedAt: "2026-02-08T10:03:00.000Z",
        outcome: "completed",
      },
      "2026-02-08T10:03:00.000Z",
    );

    expect(next.status).toBe("ready");
    expect(next.activeTurnId).toBeUndefined();
  });

  it("marks session as error on runtime error", () => {
    const previous = makeSession();
    const next = evolveSession(
      previous,
      {
        type: "error",
        sessionId: "sess-1",
        code: "runtime/error",
        message: "runtime failure",
      },
      "2026-02-08T10:04:00.000Z",
    );

    expect(next.status).toBe("error");
    expect(next.lastError).toBe("runtime failure");
  });
});

describe("applyEventToMessages", () => {
  it("handles delta/completed flow for assistant messages", () => {
    const activeAssistantMessageRef = { current: null as string | null };
    const withDelta = applyEventToMessages(
      [],
      {
        type: "message.delta",
        sessionId: "sess-1",
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "message-1",
        role: "assistant",
        delta: "Hello",
      },
      "2026-02-08T10:00:00.000Z",
      activeAssistantMessageRef,
    );

    expect(withDelta).toEqual([
      {
        id: "message-1",
        role: "assistant",
        text: "Hello",
        createdAt: "2026-02-08T10:00:00.000Z",
        streaming: true,
      },
    ]);

    const withMoreDelta = applyEventToMessages(
      withDelta,
      {
        type: "message.delta",
        sessionId: "sess-1",
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "message-1",
        role: "assistant",
        delta: " world",
      },
      "2026-02-08T10:00:01.000Z",
      activeAssistantMessageRef,
    );
    expect(withMoreDelta[0]?.text).toBe("Hello world");

    const completed = applyEventToMessages(
      withMoreDelta,
      {
        type: "message.completed",
        sessionId: "sess-1",
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "message-1",
        role: "assistant",
        text: "Hello world!",
      },
      "2026-02-08T10:00:02.000Z",
      activeAssistantMessageRef,
    );

    expect(completed[0]?.text).toBe("Hello world!");
    expect(completed[0]?.streaming).toBe(false);
  });

  it("clears streaming flags when a turn completes", () => {
    const previous: ChatMessage[] = [
      {
        id: "m-user",
        role: "user",
        text: "Hi",
        createdAt: "2026-02-08T10:00:00.000Z",
        streaming: false,
      },
      {
        id: "m-assistant",
        role: "assistant",
        text: "Typing",
        createdAt: "2026-02-08T10:00:01.000Z",
        streaming: true,
      },
    ];

    const next = applyEventToMessages(
      previous,
      {
        type: "turn.completed",
        sessionId: "sess-1",
        threadId: "thread-1",
        turnId: "turn-1",
        completedAt: "2026-02-08T10:00:02.000Z",
        outcome: "completed",
      },
      "2026-02-08T10:00:02.000Z",
      { current: null },
    );

    expect(next.every((entry) => entry.streaming === false)).toBe(true);
  });
});
