import { z } from "zod";

export const coreGitStatusSnapshotSchema = z.object({
  cwd: z.string().min(1),
  branch: z.string().min(1).nullable(),
  hasWorkingTreeChanges: z.boolean(),
  aheadCount: z.number().int().nonnegative(),
  behindCount: z.number().int().nonnegative(),
  observedAt: z.string().datetime(),
});

export const coreProjectViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cwd: z.string().min(1),
  model: z.string().min(1),
  expanded: z.boolean().default(true),
  scripts: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      command: z.string().min(1),
      icon: z.string().min(1).nullable().optional(),
      runOnWorktreeCreate: z.boolean().optional(),
    }),
  ),
});

export const coreThreadMessageViewSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.string().datetime(),
  streaming: z.boolean().default(false),
});

export const coreThreadViewSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  model: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  sessionId: z.string().min(1).nullable(),
  messages: z.array(coreThreadMessageViewSchema),
  branch: z.string().min(1).nullable(),
  worktreePath: z.string().min(1).nullable(),
});

export const coreReadModelSnapshotSchema = z.object({
  sequence: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
  projects: z.array(coreProjectViewSchema),
  threads: z.array(coreThreadViewSchema),
  git: z.array(coreGitStatusSnapshotSchema),
});

export const coreViewDeltaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    sequence: z.number().int().nonnegative(),
    snapshot: coreReadModelSnapshotSchema,
  }),
  z.object({
    kind: z.literal("projectUpsert"),
    sequence: z.number().int().nonnegative(),
    project: coreProjectViewSchema,
  }),
  z.object({
    kind: z.literal("projectDelete"),
    sequence: z.number().int().nonnegative(),
    projectId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("threadUpsert"),
    sequence: z.number().int().nonnegative(),
    thread: coreThreadViewSchema,
  }),
  z.object({
    kind: z.literal("threadDelete"),
    sequence: z.number().int().nonnegative(),
    threadId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("gitStatusUpsert"),
    sequence: z.number().int().nonnegative(),
    git: coreGitStatusSnapshotSchema,
  }),
]);

const coreCommandBaseSchema = z.object({
  commandId: z.string().min(1),
  issuedAt: z.string().datetime(),
});

export const coreCommandSchema = z.discriminatedUnion("kind", [
  coreCommandBaseSchema.extend({
    kind: z.literal("CreateProject"),
    payload: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      cwd: z.string().min(1),
      model: z.string().min(1),
    }),
  }),
  coreCommandBaseSchema.extend({
    kind: z.literal("CreateThread"),
    payload: z.object({
      id: z.string().min(1),
      projectId: z.string().min(1),
      title: z.string().min(1),
      model: z.string().min(1),
      createdAt: z.string().datetime().optional(),
    }),
  }),
  coreCommandBaseSchema.extend({
    kind: z.literal("AppendUserMessage"),
    payload: z.object({
      threadId: z.string().min(1),
      messageId: z.string().min(1),
      text: z.string(),
      createdAt: z.string().datetime(),
    }),
  }),
  coreCommandBaseSchema.extend({
    kind: z.literal("AppendAssistantMessage"),
    payload: z.object({
      threadId: z.string().min(1),
      messageId: z.string().min(1),
      text: z.string(),
      createdAt: z.string().datetime(),
    }),
  }),
  coreCommandBaseSchema.extend({
    kind: z.literal("SetThreadBranch"),
    payload: z.object({
      threadId: z.string().min(1),
      branch: z.string().min(1).nullable(),
      worktreePath: z.string().min(1).nullable(),
    }),
  }),
  coreCommandBaseSchema.extend({
    kind: z.literal("GitProbe"),
    payload: z.object({
      cwd: z.string().min(1),
    }),
  }),
  coreCommandBaseSchema.extend({
    kind: z.literal("GitWorkflow"),
    payload: z.object({
      workflow: z.enum([
        "create_branch",
        "checkout",
        "create_worktree",
        "remove_worktree",
        "stacked_action",
        "checkpoint_capture",
        "checkpoint_restore",
        "open_pr",
      ]),
      cwd: z.string().min(1),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }),
  }),
]);

export const coreDispatchInputSchema = z.object({
  command: coreCommandSchema,
  expectedVersion: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().min(1).optional(),
});

export const coreDispatchResultSchema = z.object({
  accepted: z.boolean(),
  sequence: z.number().int().nonnegative(),
});

export const coreGetSnapshotInputSchema = z.object({
  minSequence: z.number().int().nonnegative().optional(),
});

export type CoreGitStatusSnapshot = z.infer<typeof coreGitStatusSnapshotSchema>;
export type CoreProjectView = z.infer<typeof coreProjectViewSchema>;
export type CoreThreadMessageView = z.infer<typeof coreThreadMessageViewSchema>;
export type CoreThreadView = z.infer<typeof coreThreadViewSchema>;
export type CoreReadModelSnapshot = z.infer<typeof coreReadModelSnapshotSchema>;
export type CoreViewDelta = z.infer<typeof coreViewDeltaSchema>;
export type CoreCommand = z.infer<typeof coreCommandSchema>;
export type CoreDispatchInput = z.input<typeof coreDispatchInputSchema>;
export type CoreDispatchResult = z.infer<typeof coreDispatchResultSchema>;
export type CoreGetSnapshotInput = z.input<typeof coreGetSnapshotInputSchema>;
