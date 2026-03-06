import type { MessageId, NativeApi, OrchestrationReadModel, ThreadId } from "@t3tools/contracts";

import { newCommandId, newThreadId } from "../lib/utils";

import type { ChatMessage, Thread } from "../types";
import { buildTemporaryWorktreeBranchName } from "../worktreeBranches";
import { planBranchedThread } from "./Sidebar.logic";

export function selectBranchedMessages(input: {
  messages: ReadonlyArray<ChatMessage>;
  targetMessageId?: MessageId | null;
}): ChatMessage[] {
  if (!input.targetMessageId) {
    return [...input.messages];
  }

  const targetIndex = input.messages.findIndex((message) => message.id === input.targetMessageId);
  if (targetIndex < 0) {
    throw new Error("Branch target message was not found.");
  }

  const targetMessage = input.messages[targetIndex];
  if (!targetMessage || targetMessage.role !== "assistant") {
    throw new Error("Can only branch from an assistant message.");
  }

  return input.messages.slice(0, targetIndex + 1);
}

export async function branchConversationThread(input: {
  api: NativeApi;
  thread: Thread;
  seedMessages: ChatMessage[];
  projectCwd: string | null;
  createWorktree: (args: { cwd: string; branch: string }) => Promise<{
    branch: string;
    path: string;
  }>;
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  setBootstrapMessages: (threadId: ThreadId, messages: ChatMessage[]) => void;
  navigateToThread: (threadId: ThreadId) => Promise<void>;
}): Promise<ThreadId> {
  const branchedThreadId = newThreadId();
  const createdAt = new Date().toISOString();
  const plan = planBranchedThread({ thread: input.thread, projectCwd: input.projectCwd });
  let branchedThreadBranch = plan.branch;
  let branchedThreadWorktreePath = plan.worktreePath;

  if (plan.createWorktree) {
    const result = await input.createWorktree({
      cwd: plan.createWorktree.cwd,
      branch: plan.createWorktree.branch,
    });
    branchedThreadBranch = result.branch;
    branchedThreadWorktreePath = result.path;
  }

  await input.api.orchestration.dispatchCommand({
    type: "thread.create",
    commandId: newCommandId(),
    threadId: branchedThreadId,
    projectId: input.thread.projectId,
    title: plan.title,
    model: input.thread.model,
    branch: branchedThreadBranch,
    worktreePath: branchedThreadWorktreePath,
    seedMessages: input.seedMessages.map((message) => ({
      messageId: message.id,
      role: message.role,
      text: message.text,
      attachments: message.attachments ?? [],
      createdAt: message.createdAt,
      updatedAt: message.completedAt ?? message.createdAt,
    })),
    createdAt,
  });

  const snapshot = await input.api.orchestration.getSnapshot();
  input.syncServerReadModel(snapshot);
  if (input.seedMessages.length > 0) {
    input.setBootstrapMessages(branchedThreadId, input.seedMessages);
  }

  await input.navigateToThread(branchedThreadId);
  return branchedThreadId;
}

export async function createBranchedThreadWorktree(input: {
  createWorktree: (args: { cwd: string; branch: string; newBranch: string }) => Promise<{
    worktree: { branch: string; path: string };
  }>;
  cwd: string;
  branch: string;
}): Promise<{ branch: string; path: string }> {
  const result = await input.createWorktree({
    cwd: input.cwd,
    branch: input.branch,
    newBranch: buildTemporaryWorktreeBranchName(),
  });
  return {
    branch: result.worktree.branch,
    path: result.worktree.path,
  };
}
