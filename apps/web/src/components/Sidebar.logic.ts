import type { Thread } from "../types";
import { truncateTitle } from "../truncateTitle";

export interface BranchedThreadPlan {
  title: string;
  branch: string | null;
  worktreePath: string | null;
  createWorktree: {
    cwd: string;
    branch: string;
  } | null;
}

export function planBranchedThread(input: {
  thread: Pick<Thread, "title" | "branch" | "worktreePath">;
  projectCwd: string | null;
}): BranchedThreadPlan {
  const { thread, projectCwd } = input;

  if (thread.worktreePath) {
    if (!thread.branch) {
      throw new Error("Cannot branch a worktree thread without a branch.");
    }
    if (!projectCwd) {
      throw new Error("Project working directory is unavailable.");
    }
  }

  return {
    title: truncateTitle(
      thread.title.trim().length > 0 ? `Branch of ${thread.title}` : "Branched thread",
    ),
    branch: thread.branch,
    worktreePath: null,
    createWorktree: thread.worktreePath
      ? {
          cwd: projectCwd!,
          branch: thread.branch!,
        }
      : null,
  };
}
