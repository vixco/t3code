import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ProviderEvent } from "@acme/contracts";
import { ProviderManager } from "./providerManager";

function createFakeCodexAppServerBinary() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "runtime-core-fake-codex-"));
  const binaryPath = path.join(tempDir, "codex");
  const script = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let turnCount = 0;
const send = (message) => process.stdout.write(\`\${JSON.stringify(message)}\\n\`);

rl.on("line", (line) => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  if (!parsed || typeof parsed !== "object") {
    return;
  }

  if (!("id" in parsed) || typeof parsed.method !== "string") {
    return;
  }

  if (parsed.method === "initialize") {
    send({ id: parsed.id, result: {} });
    return;
  }

  if (parsed.method === "thread/start") {
    send({ id: parsed.id, result: { thread: { id: "thread-fake" } } });
    return;
  }

  if (parsed.method === "thread/resume") {
    const threadId =
      parsed.params &&
      typeof parsed.params === "object" &&
      typeof parsed.params.threadId === "string"
        ? parsed.params.threadId
        : "thread-fake";
    send({ id: parsed.id, result: { thread: { id: threadId } } });
    return;
  }

  if (parsed.method === "turn/start") {
    turnCount += 1;
    send({ id: parsed.id, result: { turn: { id: \`turn-\${turnCount}\` } } });
    setTimeout(() => {
      send({
        id: \`approval-\${turnCount}\`,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-fake",
          turnId: \`turn-\${turnCount}\`,
          itemId: \`item-\${turnCount}\`,
        },
      });
    }, 25);
    return;
  }

  if (parsed.method === "turn/interrupt") {
    send({ id: parsed.id, result: {} });
    return;
  }

  send({
    id: parsed.id,
    error: {
      code: -32601,
      message: \`Unsupported fake codex method: \${parsed.method}\`,
    },
  });
});
`;
  writeFileSync(binaryPath, script, { encoding: "utf8", mode: 0o755 });

  return {
    tempDir,
    binaryPath,
  };
}

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
      const fakeCodex = createFakeCodexAppServerBinary();
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
