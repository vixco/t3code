import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";

import { showDesktopConfirmDialog } from "./confirmDialog";
import { fixPath } from "./fixPath";

fixPath();

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const ROOT_DIR = path.resolve(__dirname, "../../..");
const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_BACKEND_PORT = 3773;
const BACKEND_READY_TIMEOUT_MS = 10_000;
const BACKEND_READY_RETRY_DELAY_MS = 100;
const BACKEND_ENTRY = path.join(ROOT_DIR, "apps/server/dist/index.mjs");
const STATE_DIR = path.join(os.homedir(), ".t3", "userdata");
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendPort = 0;
let backendAuthToken = "";
let backendWsUrl = "";
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;

function resolveBackendPort(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_BACKEND_PORT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid T3CODE_PORT: ${raw}`);
  }
  return parsed;
}

function backendEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    T3CODE_MODE: "desktop",
    T3CODE_NO_BROWSER: "1",
    T3CODE_PORT: String(backendPort),
    T3CODE_STATE_DIR: STATE_DIR,
    T3CODE_AUTH_TOKEN: backendAuthToken,
  };
}

function scheduleBackendRestart(reason: string): void {
  if (isQuitting || restartTimer) return;

  const delayMs = Math.min(500 * 2 ** restartAttempt, 10_000);
  restartAttempt += 1;
  console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBackend();
  }, delayMs);
}

function startBackend(): void {
  if (isQuitting || backendProcess) return;

  if (!fs.existsSync(BACKEND_ENTRY)) {
    scheduleBackendRestart(`missing server entry at ${BACKEND_ENTRY}`);
    return;
  }

  const child = spawn(process.execPath, [BACKEND_ENTRY], {
    cwd: ROOT_DIR,
    env: backendEnv(),
    stdio: "inherit",
  });
  backendProcess = child;

  child.once("spawn", () => {
    restartAttempt = 0;
  });

  child.on("error", (error) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    if (isQuitting) return;
    const reason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    scheduleBackendRestart(reason);
  });
}

function stopBackend(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;

  if (!child.killed) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 2_000).unref();
  }
}

function backendHttpUrl(): string {
  return `http://${LOOPBACK_HOST}:${backendPort}`;
}

function canConnectToBackendPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: LOOPBACK_HOST, port });
    let settled = false;

    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function waitForBackendReady(): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const stop = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const attempt = () => {
      if (isQuitting) {
        stop();
        reject(new Error("Backend startup cancelled while app is quitting"));
        return;
      }

      if (Date.now() - startedAt >= BACKEND_READY_TIMEOUT_MS) {
        stop();
        reject(
          new Error(
            `Backend did not start listening on ${LOOPBACK_HOST}:${backendPort} within ${BACKEND_READY_TIMEOUT_MS}ms`,
          ),
        );
        return;
      }

      void canConnectToBackendPort(backendPort)
        .then((connected) => {
          if (connected) {
            stop();
            resolve();
            return;
          }
          retryTimer = setTimeout(attempt, BACKEND_READY_RETRY_DELAY_MS);
        })
        .catch(() => {
          retryTimer = setTimeout(attempt, BACKEND_READY_RETRY_DELAY_MS);
        });
    };

    attempt();
  });
}

function registerIpcHandlers(): void {
  ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
  ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(CONFIRM_CHANNEL);
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(message, owner);
  });

  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
  ipcMain.handle(CONTEXT_MENU_CHANNEL, async (_event, items: { id: string; label: string }[]) => {
    const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (!window) return null;

    return new Promise<string | null>((resolve) => {
      const menu = Menu.buildFromTemplate(
        items.map((item) => ({
          label: item.label,
          click: () => resolve(item.id),
        })),
      );
      menu.popup({
        window,
        callback: () => resolve(null),
      });
    });
  });

  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== "string" || rawUrl.length === 0) {
      return false;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return false;
    }

    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return false;
    }

    try {
      await shell.openExternal(parsedUrl.toString());
      return true;
    } catch {
      return false;
    }
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.once("ready-to-show", () => {
    window.show();
  });

  if (isDevelopment) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadURL(backendHttpUrl());
  }

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

async function bootstrap(): Promise<void> {
  backendPort = resolveBackendPort(process.env.T3CODE_PORT);
  process.env.T3CODE_PORT = String(backendPort);
  backendAuthToken = randomBytes(24).toString("hex");
  backendWsUrl = `ws://${LOOPBACK_HOST}:${backendPort}/?token=${encodeURIComponent(backendAuthToken)}`;
  process.env.T3CODE_DESKTOP_WS_URL = backendWsUrl;

  registerIpcHandlers();
  startBackend();
  if (!isDevelopment) {
    await waitForBackendReady();
  }
  mainWindow = createWindow();
}

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
});

app.whenReady().then(() => {
  void bootstrap().catch((error) => {
    console.error("[desktop] failed to bootstrap app", error);
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
