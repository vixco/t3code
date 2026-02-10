import { describe, expect, it } from "vitest";

import { agentConfigSchema, agentExitSchema, agentWriteInputSchema, outputChunkSchema } from "./agent";

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

  it("rejects empty output session ids", () => {
    expect(() =>
      outputChunkSchema.parse({
        sessionId: "",
        stream: "stdout",
        data: "hello",
      }),
    ).toThrow();
  });
});

describe("agentWriteInputSchema", () => {
  it("accepts valid write payloads", () => {
    const parsed = agentWriteInputSchema.parse({
      sessionId: "agent-1",
      data: "ping\n",
    });

    expect(parsed.sessionId).toBe("agent-1");
  });

  it("rejects invalid write payloads", () => {
    expect(() =>
      agentWriteInputSchema.parse({
        sessionId: "",
        data: "ping\n",
      }),
    ).toThrow();

    expect(() =>
      agentWriteInputSchema.parse({
        sessionId: "agent-1",
        data: "ping\n",
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

  it("rejects empty exit session ids", () => {
    expect(() =>
      agentExitSchema.parse({
        sessionId: "",
        code: 0,
        signal: null,
      }),
    ).toThrow();
  });
});
