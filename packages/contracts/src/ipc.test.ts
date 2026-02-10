import { describe, expect, it } from "vitest";

import {
  appBootstrapResultSchema,
  appHealthResultSchema,
  dialogsPickFolderResultSchema,
  editorIdSchema,
  shellOpenInEditorInputSchema,
  WS_NATIVE_API_METHODS,
  wsNativeApiMethodSchema,
} from "./ipc";

describe("appBootstrapResultSchema", () => {
  it("accepts valid bootstrap payloads", () => {
    const parsed = appBootstrapResultSchema.parse({
      launchCwd: "/workspace",
      projectName: "workspace",
      provider: "codex",
      model: "gpt-5-codex",
      session: {
        sessionId: "sess-1",
        provider: "codex",
        status: "ready",
        cwd: "/workspace",
        model: "gpt-5-codex",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
    });

    expect(parsed.provider).toBe("codex");
  });

  it("rejects invalid bootstrap payloads", () => {
    expect(() =>
      appBootstrapResultSchema.parse({
        launchCwd: "/workspace",
        projectName: "",
        provider: "codex",
        model: "gpt-5-codex",
        session: {
          sessionId: "sess-1",
          provider: "codex",
          status: "ready",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      }),
    ).toThrow();
  });

  it("rejects empty bootstrap errors", () => {
    expect(() =>
      appBootstrapResultSchema.parse({
        launchCwd: "/workspace",
        projectName: "workspace",
        provider: "codex",
        model: "gpt-5-codex",
        session: {
          sessionId: "sess-1",
          provider: "codex",
          status: "ready",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
        bootstrapError: "",
      }),
    ).toThrow();
  });

  it("rejects unexpected bootstrap payload properties", () => {
    expect(() =>
      appBootstrapResultSchema.parse({
        launchCwd: "/workspace",
        projectName: "workspace",
        provider: "codex",
        model: "gpt-5-codex",
        session: {
          sessionId: "sess-1",
          provider: "codex",
          status: "ready",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("appHealthResultSchema", () => {
  it("accepts valid health payloads", () => {
    const parsed = appHealthResultSchema.parse({
      status: "ok",
      launchCwd: "/workspace",
      sessionCount: 2,
      activeClientConnected: true,
    });

    expect(parsed.status).toBe("ok");
  });

  it("rejects invalid health payloads", () => {
    expect(() =>
      appHealthResultSchema.parse({
        status: "ok",
        launchCwd: "/workspace",
        sessionCount: -1,
        activeClientConnected: true,
      }),
    ).toThrow();
  });

  it("rejects non-integer session counts", () => {
    expect(() =>
      appHealthResultSchema.parse({
        status: "ok",
        launchCwd: "/workspace",
        sessionCount: 1.5,
        activeClientConnected: true,
      }),
    ).toThrow();
  });

  it("rejects unexpected health payload properties", () => {
    expect(() =>
      appHealthResultSchema.parse({
        status: "ok",
        launchCwd: "/workspace",
        sessionCount: 1,
        activeClientConnected: true,
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("dialogsPickFolderResultSchema", () => {
  it("accepts null and string folder selections", () => {
    expect(dialogsPickFolderResultSchema.parse(null)).toBeNull();
    expect(dialogsPickFolderResultSchema.parse("/workspace")).toBe("/workspace");
  });

  it("rejects non-string non-null selections", () => {
    expect(() => dialogsPickFolderResultSchema.parse(123)).toThrow();
  });
});

describe("editor and shell-open schemas", () => {
  it("accepts known editor ids", () => {
    expect(editorIdSchema.parse("cursor")).toBe("cursor");
    expect(editorIdSchema.parse("file-manager")).toBe("file-manager");
  });

  it("rejects unknown editor ids", () => {
    expect(() => editorIdSchema.parse("vscode")).toThrow();
  });

  it("accepts valid shell.openInEditor payloads", () => {
    const parsed = shellOpenInEditorInputSchema.parse({
      cwd: "/workspace",
      editor: "cursor",
    });

    expect(parsed.cwd).toBe("/workspace");
    expect(parsed.editor).toBe("cursor");
  });

  it("rejects invalid shell.openInEditor payloads", () => {
    expect(() =>
      shellOpenInEditorInputSchema.parse({
        cwd: "",
        editor: "cursor",
      }),
    ).toThrow();

    expect(() =>
      shellOpenInEditorInputSchema.parse({
        cwd: "/workspace",
        editor: "vscode",
      }),
    ).toThrow();

    expect(() =>
      shellOpenInEditorInputSchema.parse({
        cwd: "/workspace",
        editor: "cursor",
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("wsNativeApiMethodSchema", () => {
  it("accepts every declared websocket native API method", () => {
    for (const method of WS_NATIVE_API_METHODS) {
      expect(wsNativeApiMethodSchema.parse(method)).toBe(method);
    }
  });

  it("rejects unknown websocket native API methods", () => {
    expect(() => wsNativeApiMethodSchema.parse("providers.abortTurn")).toThrow();
  });

  it("keeps declared websocket native API methods unique", () => {
    expect(new Set(WS_NATIVE_API_METHODS).size).toBe(WS_NATIVE_API_METHODS.length);
  });
});
