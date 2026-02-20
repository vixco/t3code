import { describe, expect, it } from "vitest";
import { serverConfigSchema } from "./server";

describe("serverConfigSchema", () => {
  it("defaults syncEngineMode to legacy when omitted", () => {
    expect(
      serverConfigSchema.parse({
        cwd: "/workspace",
        keybindings: [],
      }),
    ).toEqual({
      cwd: "/workspace",
      syncEngineMode: "legacy",
      keybindings: [],
    });
  });

  it("accepts supported sync engine modes", () => {
    expect(
      serverConfigSchema.parse({
        cwd: "/workspace",
        syncEngineMode: "livestore-read-pilot",
        keybindings: [],
      }).syncEngineMode,
    ).toBe("livestore-read-pilot");

    expect(
      serverConfigSchema.parse({
        cwd: "/workspace",
        syncEngineMode: "shadow",
        keybindings: [],
      }).syncEngineMode,
    ).toBe("shadow");

    expect(
      serverConfigSchema.parse({
        cwd: "/workspace",
        syncEngineMode: "livestore",
        keybindings: [],
      }).syncEngineMode,
    ).toBe("livestore");
  });

  it("rejects unsupported sync engine mode values", () => {
    expect(() =>
      serverConfigSchema.parse({
        cwd: "/workspace",
        syncEngineMode: "something-else",
        keybindings: [],
      }),
    ).toThrow();
  });
});
