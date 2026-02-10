import { rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ProviderEvent } from "@acme/contracts";
import { createFakeCodexAppServerBinary } from "../../../test-support/fakeCodexAppServer";
import { ProviderManager } from "./providerManager";

async function waitForProviderEvent(
  events: ProviderEvent[],
  matcher: (event: ProviderEvent) => boolean,
  timeoutMs = 5_000,
) {
  return new Promise<ProviderEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("Timed out waiting for provider event."));
    }, timeoutMs);

    const poll = setInterval(() => {
      const match = events.find((event) => matcher(event));
      if (!match) {
        return;
      }

      clearTimeout(timeout);
      clearInterval(poll);
      resolve(match);
    }, 10);
  });
}

describe("ProviderManager integration with fake codex app-server", () => {
  it(
    "supports start/send/respond/interrupt/stop lifecycle",
    async () => {
      const fakeCodex = createFakeCodexAppServerBinary("runtime-core-fake-codex-");
      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeCodex.tempDir}${path.delimiter}${originalPath ?? ""}`;

      const manager = new ProviderManager();
      const events: ProviderEvent[] = [];
      manager.on("event", (event) => {
        events.push(event);
      });

      try {
        const session = await manager.startSession({
          provider: "codex",
        });
        expect(session.provider).toBe("codex");
        expect(session.status).toBe("ready");
        expect(session.threadId).toBe("thread-fake");
        expect(session.sessionId.length).toBeGreaterThan(0);

        const turn = await manager.sendTurn({
          sessionId: session.sessionId,
          input: "hello fake codex",
        });
        expect(turn.threadId).toBe("thread-fake");
        expect(turn.turnId).toBe("turn-1");

        const approvalEvent = await waitForProviderEvent(
          events,
          (event) =>
            event.kind === "request" &&
            event.method === "item/commandExecution/requestApproval" &&
            event.sessionId === session.sessionId &&
            event.requestKind === "command" &&
            typeof event.requestId === "string" &&
            event.requestId.length > 0,
        );
        const requestId = approvalEvent.requestId;
        if (!requestId) {
          throw new Error("Expected command approval request id.");
        }

        await manager.respondToRequest({
          sessionId: session.sessionId,
          requestId,
          decision: "accept",
        });

        await manager.interruptTurn({
          sessionId: session.sessionId,
          turnId: turn.turnId,
        });

        expect(manager.listSessions().some((entry) => entry.sessionId === session.sessionId)).toBe(
          true,
        );

        manager.stopSession({
          sessionId: session.sessionId,
        });
        expect(manager.listSessions().some((entry) => entry.sessionId === session.sessionId)).toBe(
          false,
        );
      } finally {
        manager.dispose();
        process.env.PATH = originalPath;
        rmSync(fakeCodex.tempDir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
