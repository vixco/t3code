import type { OrchestrationReadModel } from "@t3tools/contracts";
import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { markThreadUnread, moveProject, syncServerReadModel, type AppState } from "./store";
import type { Project } from "./types";
import type { Thread } from "./types";

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

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Project",
    cwd: "/tmp/project",
    model: "gpt-5-codex",
    expanded: true,
    scripts: [],
    ...overrides,
  };
}

function makeState(thread: Thread, projects: Project[] = [makeProject()]): AppState {
  return {
    projects,
    projectOrder: projects.map((project) => project.id),
    threads: [thread],
    threadsHydrated: true,
    runtimeMode: "full-access",
  };
}

describe("store pure functions", () => {
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

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

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

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next).toEqual(initialState);
  });

  it("moveProject reorders projects and persists the new order", () => {
    const firstProject = makeProject({
      id: ProjectId.makeUnsafe("project-1"),
      name: "First",
      cwd: "/tmp/first",
    });
    const secondProject = makeProject({
      id: ProjectId.makeUnsafe("project-2"),
      name: "Second",
      cwd: "/tmp/second",
    });
    const thirdProject = makeProject({
      id: ProjectId.makeUnsafe("project-3"),
      name: "Third",
      cwd: "/tmp/third",
    });
    const initialState = makeState(makeThread(), [firstProject, secondProject, thirdProject]);

    const next = moveProject(
      initialState,
      ProjectId.makeUnsafe("project-3"),
      ProjectId.makeUnsafe("project-1"),
      "before",
    );

    expect(next.projects.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-3"),
      ProjectId.makeUnsafe("project-1"),
      ProjectId.makeUnsafe("project-2"),
    ]);
    expect(next.projectOrder).toEqual(next.projects.map((project) => project.id));
  });

  it("syncServerReadModel reapplies a persisted project order to fresh snapshots", () => {
    const initialState = {
      ...makeState(makeThread(), []),
      projectOrder: [
        ProjectId.makeUnsafe("project-2"),
        ProjectId.makeUnsafe("project-1"),
      ],
    };
    const readModel = {
      projects: [
        {
          id: ProjectId.makeUnsafe("project-1"),
          title: "First",
          workspaceRoot: "/tmp/first",
          defaultModel: null,
          scripts: [],
          deletedAt: null,
        },
        {
          id: ProjectId.makeUnsafe("project-2"),
          title: "Second",
          workspaceRoot: "/tmp/second",
          defaultModel: null,
          scripts: [],
          deletedAt: null,
        },
      ],
      threads: [],
    } as unknown as OrchestrationReadModel;

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
    expect(next.projectOrder).toEqual(next.projects.map((project) => project.id));
  });
});
