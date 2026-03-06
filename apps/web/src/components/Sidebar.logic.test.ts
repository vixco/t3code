import { describe, expect, it } from "vitest";

import { planBranchedThread } from "./Sidebar.logic";

describe("planBranchedThread", () => {
  it("reuses the source branch without cloning a worktree for local threads", () => {
    expect(
      planBranchedThread({
        thread: {
          title: "Original thread",
          branch: "feature/original",
          worktreePath: null,
        },
        projectCwd: "/repo",
      }),
    ).toEqual({
      title: "Branch of Original thread",
      branch: "feature/original",
      worktreePath: null,
      createWorktree: null,
    });
  });

  it("requests a fresh worktree when branching a worktree-backed thread", () => {
    expect(
      planBranchedThread({
        thread: {
          title: "Original thread",
          branch: "feature/original",
          worktreePath: "/tmp/original",
        },
        projectCwd: "/repo",
      }),
    ).toEqual({
      title: "Branch of Original thread",
      branch: "feature/original",
      worktreePath: null,
      createWorktree: {
        cwd: "/repo",
        branch: "feature/original",
      },
    });
  });

  it("uses a generic fallback title when the source title is blank", () => {
    expect(
      planBranchedThread({
        thread: {
          title: "   ",
          branch: null,
          worktreePath: null,
        },
        projectCwd: "/repo",
      }).title,
    ).toBe("Branched thread");
  });

  it("rejects worktree threads that are missing a branch", () => {
    expect(() =>
      planBranchedThread({
        thread: {
          title: "Original thread",
          branch: null,
          worktreePath: "/tmp/original",
        },
        projectCwd: "/repo",
      }),
    ).toThrow("Cannot branch a worktree thread without a branch.");
  });

  it("rejects worktree threads when the project cwd is unavailable", () => {
    expect(() =>
      planBranchedThread({
        thread: {
          title: "Original thread",
          branch: "feature/original",
          worktreePath: "/tmp/original",
        },
        projectCwd: null,
      }),
    ).toThrow("Project working directory is unavailable.");
  });
});
