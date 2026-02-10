import { z } from "zod";

export const agentSessionIdSchema = z.string().min(1);

export const agentConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  usePty: z.boolean().optional(),
}).strict();

export const outputChunkSchema = z.object({
  sessionId: z.string(),
  stream: z.enum(["stdout", "stderr"]),
  data: z.string(),
}).strict();

export const agentExitSchema = z.object({
  sessionId: z.string(),
  code: z.number().nullable(),
  signal: z.string().nullable(),
}).strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type OutputChunk = z.infer<typeof outputChunkSchema>;
export type AgentExit = z.infer<typeof agentExitSchema>;
