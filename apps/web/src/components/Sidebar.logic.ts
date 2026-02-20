import { DEFAULT_MODEL } from "../model-logic";
import { createThread } from "../threadFactory";
import type { Project, Thread } from "../types";

interface CreateLocalThreadInput {
  projectId: string;
  projects: Project[];
  options?: {
    branch?: string | null;
    worktreePath?: string | null;
  };
}

export function createLocalThreadForProject({
  projectId,
  projects,
  options,
}: CreateLocalThreadInput): Thread {
  const model = projects.find((project) => project.id === projectId)?.model ?? DEFAULT_MODEL;
  return createThread(projectId, {
    model,
    branch: options?.branch ?? null,
    worktreePath: options?.worktreePath ?? null,
  });
}
