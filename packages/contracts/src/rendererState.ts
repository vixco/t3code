import { z } from "zod";

export const RENDERER_STATE_MAX_JSON_CHARS = 25_000_000;

export const rendererStateSnapshotSchema = z.object({
  stateJson: z.string().min(1).max(RENDERER_STATE_MAX_JSON_CHARS),
  updatedAt: z.string().datetime(),
});

export const rendererStateSetInputSchema = z.object({
  stateJson: z.string().min(1).max(RENDERER_STATE_MAX_JSON_CHARS),
});

export type RendererStateSnapshot = z.infer<typeof rendererStateSnapshotSchema>;
export type RendererStateSetInput = z.input<typeof rendererStateSetInputSchema>;
