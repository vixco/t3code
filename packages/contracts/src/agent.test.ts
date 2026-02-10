import { describe, expect, it } from "vitest";

import { agentConfigSchema, agentExitSchema, outputChunkSchema } from "./agent";

describe("agentConfigSchema", () => {
  it("accepts valid agent configs", () => {
    const parsed = agentConfigSchema.parse({
      command: "bash",
      args: ["-lc", "echo hi"],
      cwd: "/workspace",
      usePty: false,
    });

    expect(parsed.command).toBe("bash");
  });

  it("rejects unexpected config properties", () => {
    expect(() =>
      agentConfigSchema.parse({
        command: "bash",
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("outputChunkSchema", () => {
  it("accepts stdout/stderr output chunks", () => {
    expect(
      outputChunkSchema.parse({
        sessionId: "agent-1",
        stream: "stdout",
        data: "hello",
      }).stream,
    ).toBe("stdout");
  });

  it("rejects unexpected output properties", () => {
    expect(() =>
      outputChunkSchema.parse({
        sessionId: "agent-1",
        stream: "stdout",
        data: "hello",
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("agentExitSchema", () => {
  it("accepts exit payloads", () => {
    const parsed = agentExitSchema.parse({
      sessionId: "agent-1",
      code: 0,
      signal: null,
    });

    expect(parsed.code).toBe(0);
  });

  it("rejects unexpected exit properties", () => {
    expect(() =>
      agentExitSchema.parse({
        sessionId: "agent-1",
        code: 0,
        signal: null,
        unexpected: true,
      }),
    ).toThrow();
  });
});
