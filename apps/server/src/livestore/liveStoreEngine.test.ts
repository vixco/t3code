import { describe, expect, it } from "vitest";
import type { StateBootstrapResult, StateEvent } from "@t3tools/contracts";
import { diffStateSnapshots, isStateSnapshotInParity } from "./parity";
import { LiveStoreStateMirror } from "./liveStoreEngine";

function makeEvent(input: StateEvent): StateEvent {
  return input;
}

function makeExpectedSnapshot(): StateBootstrapResult {
  return {
    projects: [
      {
        id: "project-1",
        cwd: "/workspace/project",
        name: "project",
        scripts: [],
        createdAt: "2026-02-20T00:00:00.000Z",
        updatedAt: "2026-02-20T00:00:01.000Z",
      },
    ],
    threads: [
      {
        id: "thread-1",
        codexThreadId: null,
        projectId: "project-1",
        title: "Thread",
        model: "gpt-5.3-codex",
        terminalOpen: false,
        terminalHeight: 280,
        terminalIds: ["default"],
        runningTerminalIds: [],
        activeTerminalId: "default",
        terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
        activeTerminalGroupId: "group-default",
        createdAt: "2026-02-20T00:00:00.000Z",
        updatedAt: "2026-02-20T00:00:02.000Z",
        branch: null,
        worktreePath: null,
        turnDiffSummaries: [
          {
            turnId: "turn-1",
            completedAt: "2026-02-20T00:00:04.000Z",
            files: [],
          },
        ],
        messages: [
          {
            id: "message-1",
            threadId: "thread-1",
            role: "user",
            text: "hello",
            createdAt: "2026-02-20T00:00:03.000Z",
            updatedAt: "2026-02-20T00:00:03.000Z",
            streaming: false,
          },
        ],
      },
    ],
    lastStateSeq: 4,
  };
}

describe("LiveStoreStateMirror", () => {
  it("projects mirrored state events into a parity snapshot", async () => {
    const mirror = new LiveStoreStateMirror({ storeId: "shadow-parity-test" });
    const events: StateEvent[] = [
      makeEvent({
        seq: 1,
        eventType: "project.upsert",
        entityId: "project-1",
        createdAt: "2026-02-20T00:00:01.000Z",
        payload: {
          project: {
            id: "project-1",
            cwd: "/workspace/project",
            name: "project",
            scripts: [],
            createdAt: "2026-02-20T00:00:00.000Z",
            updatedAt: "2026-02-20T00:00:01.000Z",
          },
        },
      }),
      makeEvent({
        seq: 2,
        eventType: "thread.upsert",
        entityId: "thread-1",
        createdAt: "2026-02-20T00:00:02.000Z",
        payload: {
          thread: {
            id: "thread-1",
            codexThreadId: null,
            projectId: "project-1",
            title: "Thread",
            model: "gpt-5.3-codex",
            terminalOpen: false,
            terminalHeight: 280,
            terminalIds: ["default"],
            runningTerminalIds: [],
            activeTerminalId: "default",
            terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
            activeTerminalGroupId: "group-default",
            createdAt: "2026-02-20T00:00:00.000Z",
            updatedAt: "2026-02-20T00:00:02.000Z",
            branch: null,
            worktreePath: null,
          },
        },
      }),
      makeEvent({
        seq: 3,
        eventType: "message.upsert",
        entityId: "thread-1:message-1",
        createdAt: "2026-02-20T00:00:03.000Z",
        payload: {
          threadId: "thread-1",
          message: {
            id: "message-1",
            threadId: "thread-1",
            role: "user",
            text: "hello",
            createdAt: "2026-02-20T00:00:03.000Z",
            updatedAt: "2026-02-20T00:00:03.000Z",
            streaming: false,
          },
        },
      }),
      makeEvent({
        seq: 4,
        eventType: "turn_summary.upsert",
        entityId: "thread-1:turn-1",
        createdAt: "2026-02-20T00:00:04.000Z",
        payload: {
          threadId: "thread-1",
          turnSummary: {
            turnId: "turn-1",
            completedAt: "2026-02-20T00:00:04.000Z",
            files: [],
          },
        },
      }),
    ];

    try {
      for (const event of events) {
        await mirror.mirrorStateEvent(event);
      }

      const expected = makeExpectedSnapshot();
      const actual = mirror.debugReadSnapshot();
      expect(diffStateSnapshots(expected, actual)).toEqual([]);
      expect(isStateSnapshotInParity(expected, actual)).toBe(true);
    } finally {
      await mirror.dispose();
    }
  });

  it("handles delete events in mirrored projections", async () => {
    const mirror = new LiveStoreStateMirror({ storeId: "shadow-delete-test" });
    try {
      await mirror.mirrorStateEvent(
        makeEvent({
          seq: 1,
          eventType: "project.upsert",
          entityId: "project-1",
          createdAt: "2026-02-20T00:00:00.000Z",
          payload: {
            project: {
              id: "project-1",
              cwd: "/workspace/project",
              name: "project",
              scripts: [],
              createdAt: "2026-02-20T00:00:00.000Z",
              updatedAt: "2026-02-20T00:00:00.000Z",
            },
          },
        }),
      );
      await mirror.mirrorStateEvent(
        makeEvent({
          seq: 2,
          eventType: "project.delete",
          entityId: "project-1",
          createdAt: "2026-02-20T00:00:01.000Z",
          payload: { projectId: "project-1" },
        }),
      );

      const snapshot = mirror.debugReadSnapshot();
      expect(snapshot.projects).toEqual([]);
      expect(snapshot.threads).toEqual([]);
      expect(snapshot.lastStateSeq).toBe(2);
    } finally {
      await mirror.dispose();
    }
  });
});
