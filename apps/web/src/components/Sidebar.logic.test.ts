import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL } from "../model-logic";
import { createLocalThreadForProject } from "./Sidebar.logic";

describe("createLocalThreadForProject", () => {
  it("creates a local thread with the project's configured model", () => {
    const thread = createLocalThreadForProject({
      projectId: "project-1",
      projects: [
        {
          id: "project-1",
          name: "Project",
          cwd: "/tmp/project",
          model: "custom-project-model",
          expanded: true,
          scripts: [],
        },
      ],
      options: {
        branch: "feature/test",
        worktreePath: "/tmp/project/worktrees/feature-test",
      },
    });

    expect(thread.projectId).toBe("project-1");
    expect(thread.model).toBe("custom-project-model");
    expect(thread.branch).toBe("feature/test");
    expect(thread.worktreePath).toBe("/tmp/project/worktrees/feature-test");
  });

  it("falls back to the default model when the project is missing", () => {
    const thread = createLocalThreadForProject({
      projectId: "missing-project",
      projects: [],
    });

    expect(thread.projectId).toBe("missing-project");
    expect(thread.model).toBe(DEFAULT_MODEL);
    expect(thread.branch).toBeNull();
    expect(thread.worktreePath).toBeNull();
  });
});
