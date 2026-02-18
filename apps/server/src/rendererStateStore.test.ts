import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RendererStateStore } from "./rendererStateStore";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("RendererStateStore", () => {
  it("returns null when no renderer state has been saved", async () => {
    const stateDir = makeTempDir("t3code-renderer-state-empty-");
    const store = new RendererStateStore(stateDir);

    await expect(store.get()).resolves.toBeNull();

    await store.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists and reloads renderer state from sqlite", async () => {
    const stateDir = makeTempDir("t3code-renderer-state-roundtrip-");
    const firstStore = new RendererStateStore(stateDir);
    const payload =
      '{"version":8,"projects":[],"threads":[],"activeThreadId":null,"runtimeMode":"full-access"}';

    await firstStore.set({ stateJson: payload });
    const firstRead = await firstStore.get();
    expect(firstRead).toMatchObject({
      stateJson: payload,
      updatedAt: expect.any(String),
    });
    await firstStore.close();

    const secondStore = new RendererStateStore(stateDir);
    const secondRead = await secondStore.get();
    expect(secondRead).toMatchObject({
      stateJson: payload,
      updatedAt: expect.any(String),
    });
    await secondStore.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
});
