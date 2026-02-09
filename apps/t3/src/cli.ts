#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

import { startRuntimeApiServer } from "./runtimeApiServer";

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? "cmd"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function main() {
  const backendPort = parsePort(process.env.T3_BACKEND_PORT, 4317);
  const webPort = parsePort(process.env.T3_WEB_PORT, 4318);
  const launchCwd = process.cwd();

  const runtimeServer = await startRuntimeApiServer({
    port: backendPort,
    launchCwd,
  });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rendererRoot = path.resolve(__dirname, "../../renderer");
  const viteServer = await createViteServer({
    configFile: path.join(rendererRoot, "vite.config.ts"),
    root: rendererRoot,
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
    },
  });
  await viteServer.listen();

  const wsParam = encodeURIComponent(runtimeServer.wsUrl);
  const appUrl = `http://127.0.0.1:${webPort}?ws=${wsParam}`;
  openBrowser(appUrl);

  process.stdout.write(`CodeThing is running at ${appUrl}\n`);

  const shutdown = async () => {
    await Promise.all([viteServer.close(), runtimeServer.close()]);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main();
