import {
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  markThreadUnread,
  reorderProjects,
  syncServerReadModel,
  type AppState,
} from "./store";
import type { Project, Thread } from "./types";

function makeProject(id: string, cwd = `/tmp/${id}`): Project {
  return {
    id: ProjectId.makeUnsafe(id),
    name: id,
    cwd,
    model: "gpt-5-codex",
    expanded: true,
    scripts: [],
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(
  thread: Thread,
  projects: Project[] = [makeProject("project-1")],
): AppState {
  return {
    projects,
    threads: [thread],
    threadsHydrated: true,
    runtimeMode: "full-access",
  };
}

function makeReadModel(
  projects: Array<{ id: string; cwd?: string }>,
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: projects.map((project) => ({
      id: ProjectId.makeUnsafe(project.id),
      title: project.id,
      workspaceRoot: project.cwd ?? `/tmp/${project.id}`,
      defaultModel: "gpt-5-codex",
      scripts: [],
      createdAt: "2026-02-25T12:00:00.000Z",
      updatedAt: "2026-02-25T12:00:00.000Z",
      deletedAt: null,
    })),
    threads: [],
    updatedAt: "2026-02-25T12:00:00.000Z",
  };
}

describe("store pure functions", () => {
  it("reorderProjects moves a project to the end insertion slot", () => {
    const initialState = makeState(makeThread(), [
      makeProject("project-1"),
      makeProject("project-2"),
      makeProject("project-3"),
    ]);

    const next = reorderProjects(
      initialState,
      ProjectId.makeUnsafe("project-1"),
      3,
    );

    expect(next.projects.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-3"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("syncServerReadModel keeps the existing local project order and appends new projects", () => {
    const initialState = makeState(makeThread(), [
      makeProject("project-b", "/tmp/project-b"),
      makeProject("project-a", "/tmp/project-a"),
    ]);

    const next = syncServerReadModel(
      initialState,
      makeReadModel([
        { id: "project-a", cwd: "/tmp/project-a" },
        { id: "project-b", cwd: "/tmp/project-b" },
        { id: "project-c", cwd: "/tmp/project-c" },
      ]),
    );

    expect(next.projects.map((project) => project.cwd)).toEqual([
      "/tmp/project-b",
      "/tmp/project-a",
      "/tmp/project-c",
    ]);
  });

  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(
      initialState,
      ThreadId.makeUnsafe("thread-1"),
    );

    const updatedThread = next.threads[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(
      initialState,
      ThreadId.makeUnsafe("thread-1"),
    );

    expect(next).toEqual(initialState);
  });
});
