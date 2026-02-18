import { describe, expect, it } from "vitest";

import { rendererStateSetInputSchema, rendererStateSnapshotSchema } from "./rendererState";

describe("rendererState contracts", () => {
  it("parses renderer state snapshot", () => {
    const parsed = rendererStateSnapshotSchema.parse({
      stateJson: '{"version":8,"projects":[],"threads":[],"activeThreadId":null,"runtimeMode":"full-access"}',
      updatedAt: "2026-02-18T10:00:00.000Z",
    });

    expect(parsed.updatedAt).toBe("2026-02-18T10:00:00.000Z");
  });

  it("requires non-empty stateJson for set input", () => {
    expect(() => rendererStateSetInputSchema.parse({ stateJson: "" })).toThrow();
  });
});
