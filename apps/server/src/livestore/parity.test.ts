import { describe, expect, it } from "vitest";
import type { StateBootstrapResult } from "@t3tools/contracts";
import { diffStateSnapshots, isStateSnapshotInParity } from "./parity";

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
