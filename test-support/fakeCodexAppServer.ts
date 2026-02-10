import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function createFakeCodexAppServerBinary(prefix: string) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
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
