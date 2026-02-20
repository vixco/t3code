import { z } from "zod";
import { keybindingRuleSchema, resolvedKeybindingsConfigSchema } from "./keybindings";

export const serverConfigSchema = z.object({
  cwd: z.string().min(1),
  syncEngineMode: z.enum(["legacy", "shadow", "livestore-read-pilot"]).default("legacy"),
  keybindings: resolvedKeybindingsConfigSchema.default([]),
});

export const serverUpsertKeybindingInputSchema = keybindingRuleSchema;

export const serverUpsertKeybindingResultSchema = z.object({
  keybindings: resolvedKeybindingsConfigSchema.default([]),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ServerUpsertKeybindingInput = z.infer<typeof serverUpsertKeybindingInputSchema>;
export type ServerUpsertKeybindingResult = z.infer<typeof serverUpsertKeybindingResultSchema>;
