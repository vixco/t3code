import { describe, expect, it } from "vitest";
import type { StateBootstrapResult } from "@t3tools/contracts";
import {
  diffCatchUpResults,
  diffListMessagesResults,
  diffStateSnapshots,
  isStateSnapshotInParity,
} from "./parity";

function makeSnapshot(overrides: Partial<StateBootstrapResult> = {}): StateBootstrapResult {
  return {
    projects: [],
    threads: [],
    lastStateSeq: 0,
    ...overrides,
  };
}

describe("diffStateSnapshots", () => {
  it("treats snapshots with different ordering as parity-equal", () => {
    const projectA = {
      id: "project-a",
      cwd: "/workspace/a",
      name: "A",
      scripts: [],
      createdAt: "2026-02-20T00:00:00.000Z",
      updatedAt: "2026-02-20T00:00:00.000Z",
    };
    const projectB = {
      id: "project-b",
      cwd: "/workspace/b",
      name: "B",
      scripts: [],
      createdAt: "2026-02-20T00:00:00.000Z",
      updatedAt: "2026-02-20T00:00:00.000Z",
    };
    const threadA = {
      id: "thread-a",
      codexThreadId: null,
      projectId: "project-a",
      title: "Thread A",
      model: "gpt-5.3-codex",
      terminalOpen: false,
      terminalHeight: 280,
      terminalIds: ["default"],
      runningTerminalIds: [],
      activeTerminalId: "default",
      terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
      activeTerminalGroupId: "group-default",
      createdAt: "2026-02-20T00:00:00.000Z",
      updatedAt: "2026-02-20T00:00:00.000Z",
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [
        {
          turnId: "turn-2",
          completedAt: "2026-02-20T00:00:02.000Z",
          files: [],
        },
        {
          turnId: "turn-1",
          completedAt: "2026-02-20T00:00:01.000Z",
          files: [],
        },
      ],
      messages: [
        {
          id: "msg-2",
          threadId: "thread-a",
          role: "assistant" as const,
          text: "hello",
          createdAt: "2026-02-20T00:00:02.000Z",
          updatedAt: "2026-02-20T00:00:02.000Z",
          streaming: false,
        },
        {
          id: "msg-1",
          threadId: "thread-a",
          role: "user" as const,
          text: "hi",
          createdAt: "2026-02-20T00:00:01.000Z",
          updatedAt: "2026-02-20T00:00:01.000Z",
          streaming: false,
        },
      ],
    };

    const expected = makeSnapshot({
      projects: [projectA, projectB],
      threads: [threadA],
      lastStateSeq: 10,
    });
    const actual = makeSnapshot({
      projects: [projectB, projectA],
      threads: [
        {
          ...threadA,
          turnDiffSummaries: [...threadA.turnDiffSummaries].toReversed(),
          messages: [...threadA.messages].toReversed(),
        },
      ],
      lastStateSeq: 10,
    });

    expect(diffStateSnapshots(expected, actual)).toEqual([]);
    expect(isStateSnapshotInParity(expected, actual)).toBe(true);
  });

  it("reports path-qualified diffs when snapshots diverge", () => {
    const expected = makeSnapshot({
      projects: [
        {
          id: "project-a",
          cwd: "/workspace/a",
          name: "Project A",
          scripts: [],
          createdAt: "2026-02-20T00:00:00.000Z",
          updatedAt: "2026-02-20T00:00:00.000Z",
        },
      ],
      lastStateSeq: 5,
    });
    const actual = makeSnapshot({
      projects: [
        {
          id: "project-a",
          cwd: "/workspace/a",
          name: "Project A renamed",
          scripts: [],
          createdAt: "2026-02-20T00:00:00.000Z",
          updatedAt: "2026-02-20T00:00:00.000Z",
        },
      ],
      lastStateSeq: 7,
    });

    const diffs = diffStateSnapshots(expected, actual);
    expect(diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.lastStateSeq",
          expected: 5,
          actual: 7,
        }),
        expect.objectContaining({
          path: "$.projects[0].name",
          expected: "Project A",
          actual: "Project A renamed",
        }),
      ]),
    );
    expect(isStateSnapshotInParity(expected, actual)).toBe(false);
  });
});

describe("diffCatchUpResults", () => {
  it("returns empty diff when catch-up payloads are equal", () => {
    const catchUp = {
      events: [
        {
          seq: 1,
          eventType: "project.upsert" as const,
          entityId: "project-1",
          payload: { project: { id: "project-1", name: "Demo" } },
          createdAt: "2026-02-20T00:00:00.000Z",
        },
      ],
      lastStateSeq: 1,
    };

    expect(diffCatchUpResults(catchUp, catchUp)).toEqual([]);
  });

  it("returns targeted diffs for catch-up payload drift", () => {
    const expected = {
      events: [
        {
          seq: 1,
          eventType: "project.upsert" as const,
          entityId: "project-1",
          payload: { project: { id: "project-1", name: "Demo" } },
          createdAt: "2026-02-20T00:00:00.000Z",
        },
      ],
      lastStateSeq: 1,
    };
    const actual = {
      events: [
        {
          seq: 2,
          eventType: "project.delete" as const,
          entityId: "project-2",
          payload: { projectId: "project-2" },
          createdAt: "2026-02-20T00:00:00.000Z",
        },
      ],
      lastStateSeq: 2,
    };

    expect(diffCatchUpResults(expected, actual)).toEqual(
      expect.arrayContaining([
        "lastStateSeq mismatch: expected=1 actual=2",
        "events[0].seq mismatch: expected=1 actual=2",
        "events[0].eventType mismatch: expected=project.upsert actual=project.delete",
        "events[0].entityId mismatch: expected=project-1 actual=project-2",
        "events[0].payload mismatch",
      ]),
    );
  });
});

describe("diffListMessagesResults", () => {
  it("returns empty diff for equivalent list-messages responses", () => {
    const result = {
      messages: [
        {
          id: "message-1",
          threadId: "thread-1",
          role: "user" as const,
          text: "hello",
          createdAt: "2026-02-20T00:00:00.000Z",
          updatedAt: "2026-02-20T00:00:00.000Z",
          streaming: false,
        },
      ],
      total: 1,
      nextOffset: null,
    };
    expect(diffListMessagesResults(result, result)).toEqual([]);
  });

  it("returns targeted diffs for list-messages drift", () => {
    const expected = {
      messages: [],
      total: 1,
      nextOffset: 1,
    };
    const actual = {
      messages: [
        {
          id: "message-2",
          threadId: "thread-1",
          role: "assistant" as const,
          text: "hi",
          createdAt: "2026-02-20T00:00:00.000Z",
          updatedAt: "2026-02-20T00:00:00.000Z",
          streaming: false,
        },
      ],
      total: 2,
      nextOffset: null,
    };

    expect(diffListMessagesResults(expected, actual)).toEqual(
      expect.arrayContaining([
        "total mismatch: expected=1 actual=2",
        "nextOffset mismatch: expected=1 actual=null",
        "messages.length mismatch: expected=0 actual=1",
      ]),
    );
  });
});
