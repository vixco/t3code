import { describe, expect, it } from "vitest";

import { shouldRunTerminalPerfInteractions } from "./perfConfig";

describe("shouldRunTerminalPerfInteractions", () => {
  it("defaults to enabled outside CI when env is unset", () => {
    expect(shouldRunTerminalPerfInteractions({ CI: "false" })).toBe(true);
    expect(shouldRunTerminalPerfInteractions({ CI: undefined })).toBe(true);
  });

  it("defaults to disabled in CI when env is unset", () => {
    expect(shouldRunTerminalPerfInteractions({ CI: "true" })).toBe(false);
  });

  it("supports explicit true values", () => {
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "1",
        CI: "true",
      }),
    ).toBe(true);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: " true ",
        CI: "true",
      }),
    ).toBe(true);
  });

  it("supports explicit false values", () => {
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "0",
        CI: "false",
      }),
    ).toBe(false);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: " false ",
        CI: "false",
      }),
    ).toBe(false);
  });
});
