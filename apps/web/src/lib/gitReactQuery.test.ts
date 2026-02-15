import { describe, expect, it } from "vitest";

import { projectGitBranchesToCurrent } from "./gitReactQuery";

describe("projectGitBranchesToCurrent", () => {
  it("moves the checked out branch to the top and marks it current", () => {
    const result = projectGitBranchesToCurrent(
      {
        isRepo: true,
        branches: [
          { name: "main", current: true, isDefault: true, worktreePath: null },
          { name: "feature/a", current: false, isDefault: false, worktreePath: null },
          { name: "feature/b", current: false, isDefault: false, worktreePath: null },
        ],
      },
      "feature/a",
    );

    expect(result).toEqual({
      isRepo: true,
      branches: [
        { name: "feature/a", current: true, isDefault: false, worktreePath: null },
        { name: "main", current: false, isDefault: true, worktreePath: null },
        { name: "feature/b", current: false, isDefault: false, worktreePath: null },
      ],
    });
  });

  it("inserts a missing branch as current", () => {
    const result = projectGitBranchesToCurrent(
      {
        isRepo: true,
        branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
      },
      "feature/new",
    );

    expect(result).toEqual({
      isRepo: true,
      branches: [
        { name: "feature/new", current: true, isDefault: false, worktreePath: null },
        { name: "main", current: false, isDefault: true, worktreePath: null },
      ],
    });
  });

  it("returns undefined when no cached branch list exists yet", () => {
    expect(projectGitBranchesToCurrent(undefined, "feature/new")).toBeUndefined();
  });
});
