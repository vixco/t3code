import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  app,
  BrowserWindow,
  contentTracing,
  dialog,
  ipcMain,
  Menu,
  shell,
  type WebContents,
} from "electron";

import { showDesktopConfirmDialog } from "./confirmDialog";
import { fixPath } from "./fixPath";

fixPath();

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const ROOT_DIR = path.resolve(__dirname, "../../..");
const BACKEND_ENTRY = path.join(ROOT_DIR, "apps/server/dist/index.mjs");
const WEB_ENTRY = path.join(ROOT_DIR, "apps/web/dist/index.html");
const STATE_DIR = process.env.T3CODE_STATE_DIR?.trim() || path.join(os.homedir(), ".t3", "userdata");
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const PERF_AUTOMATION_ENABLED = process.env.T3CODE_DESKTOP_PERF_AUTOMATION === "1";
const PERF_TRACE_OUT_PATH = process.env.T3CODE_DESKTOP_PERF_TRACE_OUT?.trim() ?? "";
const PERF_DONE_OUT_PATH = process.env.T3CODE_DESKTOP_PERF_DONE_OUT?.trim() ?? "";

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendPort = 0;
let backendAuthToken = "";
let backendWsUrl = "";
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForDidFinishLoad(webContents: WebContents): Promise<void> {
  if (!webContents.isLoading()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onLoad = () => resolve();
    webContents.once("did-finish-load", onLoad);
  });
}

interface PerfPersistedMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  streaming: false;
}

interface PerfPersistedThread {
  id: string;
  projectId: string;
  title: string;
  model: string;
  terminalOpen: false;
  messages: PerfPersistedMessage[];
  createdAt: string;
  lastVisitedAt: string;
}

interface PerfPersistedProject {
  id: string;
  name: string;
  cwd: string;
  model: string;
  expanded: true;
}

interface PerfPersistedState {
  version: 7;
  runtimeMode: "approval-required";
  projects: PerfPersistedProject[];
  threads: PerfPersistedThread[];
  activeThreadId: string | null;
}

function buildPerfSeedState(): PerfPersistedState {
  const now = Date.now();
  const projects: PerfPersistedProject[] = [
    {
      id: "perf-project-1",
      name: "codething-mvp",
      cwd: "/tmp/perf/codething-mvp",
      model: "gpt-5-codex",
      expanded: true,
    },
    {
      id: "perf-project-2",
      name: "contracts-bench",
      cwd: "/tmp/perf/contracts-bench",
      model: "gpt-5-codex",
      expanded: true,
    },
  ];

  const threads: PerfPersistedThread[] = [];
  let threadOrdinal = 0;

  for (const project of projects) {
    for (let threadIndex = 0; threadIndex < 5; threadIndex += 1) {
      const threadId = `${project.id}-thread-${threadIndex + 1}`;
      const threadCreatedAt = new Date(now - (threadOrdinal + 1) * 45_000).toISOString();
      const messages: PerfPersistedMessage[] = [];
      const exchangeCount = 6;
      for (let exchangeIndex = 0; exchangeIndex < exchangeCount; exchangeIndex += 1) {
        const msgBaseOffsetMs =
          (threadOrdinal * exchangeCount + exchangeIndex + 1) * 4_500 + threadIndex * 850;
        const userCreatedAt = new Date(now - msgBaseOffsetMs - 1_500).toISOString();
        const assistantCreatedAt = new Date(now - msgBaseOffsetMs).toISOString();
        messages.push({
          id: `${threadId}-user-${exchangeIndex + 1}`,
          role: "user",
          text: `Investigate renderer performance pattern ${exchangeIndex + 1} for ${project.name}.`,
          createdAt: userCreatedAt,
          streaming: false,
        });
        messages.push({
          id: `${threadId}-assistant-${exchangeIndex + 1}`,
          role: "assistant",
          text: [
            `Profiling note ${exchangeIndex + 1}:`,
            "- Checked event dispatch and render cadence.",
            "- Compared selector interactions and thread switches.",
            "- Captured actionable optimization candidates.",
          ].join("\n"),
          createdAt: assistantCreatedAt,
          streaming: false,
        });
      }

      threads.push({
        id: threadId,
        projectId: project.id,
        title: `${project.name} perf thread ${threadIndex + 1}`,
        model: "gpt-5-codex",
        terminalOpen: false,
        messages,
        createdAt: threadCreatedAt,
        lastVisitedAt: new Date(now - threadOrdinal * 2_000).toISOString(),
      });
      threadOrdinal += 1;
    }
  }

  return {
    version: 7,
    runtimeMode: "approval-required",
    projects,
    threads,
    activeThreadId: threads[0]?.id ?? null,
  };
}

async function seedRendererState(window: BrowserWindow): Promise<void> {
  const state = buildPerfSeedState();
  const script = `
    (() => {
      const key = "t3code:renderer-state:v7";
      localStorage.setItem(key, JSON.stringify(${JSON.stringify(state)}));
      return true;
    })();
  `;
  await window.webContents.executeJavaScript(script, true);
}

async function runRendererPerfInteractions(
  window: BrowserWindow,
): Promise<{ threadClicks: number; typedChars: number; selectedModel: string | null }> {
  const script = `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const must = (condition, message) => {
        if (!condition) throw new Error(message);
      };

      const clickElement = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        node.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        node.click();
        return true;
      };

      const threadButtons = Array.from(document.querySelectorAll("[data-perf-thread-id]"));
      must(threadButtons.length >= 4, "Expected seeded thread rows to be rendered.");

      const clickCount = Math.min(8, threadButtons.length);
      for (let index = 0; index < clickCount; index += 1) {
        clickElement(threadButtons[index]);
        await sleep(80);
      }

      const scroller = document.querySelector("[data-perf-messages-scroll]");
      if (scroller instanceof HTMLElement) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
        await sleep(60);
        scroller.scrollTo({ top: 0, behavior: "instant" });
        await sleep(60);
      }

      const textarea = document.querySelector("[data-perf-composer-input]");
      must(textarea instanceof HTMLTextAreaElement, "Composer textarea missing.");
      textarea.focus();

      const valueDescriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      );
      const setValue = valueDescriptor?.set;
      must(typeof setValue === "function", "Textarea value setter unavailable.");
      const inputText = "Benchmarking typing and selector workflows in desktop mode.";

      for (const character of inputText) {
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", { key: character, bubbles: true, cancelable: true }),
        );
        setValue.call(textarea, textarea.value + character);
        textarea.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        textarea.dispatchEvent(
          new KeyboardEvent("keyup", { key: character, bubbles: true, cancelable: true }),
        );
        await sleep(8);
      }

      const selectOption = async (triggerSelector, optionSelector, label) => {
        const trigger = document.querySelector(triggerSelector);
        must(trigger instanceof HTMLElement, label + " trigger not found.");
        clickElement(trigger);
        await sleep(130);

        const options = Array.from(document.querySelectorAll(optionSelector)).filter(
          (node) => node instanceof HTMLElement,
        );
        must(options.length > 0, label + " options not found.");
        const preferred = options[1] ?? options[0];
        clickElement(preferred);
        await sleep(130);
        return preferred.textContent?.trim() ?? null;
      };

      const selectedModel = await selectOption(
        "[data-perf-model-trigger]",
        "[data-perf-model-option]",
        "Model",
      );
      await selectOption(
        "[data-perf-reasoning-trigger]",
        "[data-perf-reasoning-option]",
        "Reasoning",
      );

      const diffToggle = document.querySelector("[data-perf-diff-toggle]");
      if (diffToggle instanceof HTMLElement) {
        clickElement(diffToggle);
        await sleep(70);
        clickElement(diffToggle);
        await sleep(70);
      }

      const runtimeToggle = document.querySelector("[data-perf-runtime-toggle]");
      if (runtimeToggle instanceof HTMLElement) {
        clickElement(runtimeToggle);
        await sleep(100);
      }

      return {
        threadClicks: clickCount,
        typedChars: inputText.length,
        selectedModel,
      };
    })();
  `;

  return window.webContents.executeJavaScript(script, true);
}

async function runPerfAutomation(window: BrowserWindow): Promise<void> {
  if (!PERF_AUTOMATION_ENABLED) return;
  console.log("[desktop-perf] automation mode enabled");
  if (PERF_DONE_OUT_PATH.length > 0) {
    console.log(`[desktop-perf] done marker path: ${PERF_DONE_OUT_PATH}`);
  }
  console.log(`[desktop-perf] trace path: ${PERF_TRACE_OUT_PATH}`);

  if (PERF_TRACE_OUT_PATH.length === 0) {
    const error = new Error("T3CODE_DESKTOP_PERF_TRACE_OUT is required for perf automation.");
    console.error("[desktop-perf] " + error.message);
    if (PERF_DONE_OUT_PATH.length > 0) {
      fs.mkdirSync(path.dirname(PERF_DONE_OUT_PATH), { recursive: true });
      fs.writeFileSync(
        PERF_DONE_OUT_PATH,
        JSON.stringify(
          {
            status: "error",
            error: error.message,
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  const traceConfig = {
    included_categories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "blink.user_timing",
      "v8",
      "disabled-by-default-v8.cpu_profiler",
      "disabled-by-default-v8.gc",
    ],
    record_mode: "record-until-full",
  };

  let tracePath = PERF_TRACE_OUT_PATH;
  const startedAt = Date.now();
  try {
    console.log("[desktop-perf] waiting for initial load");
    await waitForDidFinishLoad(window.webContents);
    console.log("[desktop-perf] seeding renderer state");
    await seedRendererState(window);
    window.webContents.reload();
    console.log("[desktop-perf] waiting for reload");
    await waitForDidFinishLoad(window.webContents);
    await delay(300);

    fs.mkdirSync(path.dirname(PERF_TRACE_OUT_PATH), { recursive: true });
    console.log("[desktop-perf] starting trace recording");
    await contentTracing.startRecording(traceConfig);
    console.log("[desktop-perf] running scripted interactions");
    const interactions = await runRendererPerfInteractions(window);
    await delay(300);
    console.log("[desktop-perf] stopping trace recording");
    tracePath = await contentTracing.stopRecording(PERF_TRACE_OUT_PATH);
    const completedAt = Date.now();

    console.log(`[desktop-perf] trace recorded at ${tracePath}`);
    if (PERF_DONE_OUT_PATH.length > 0) {
      fs.mkdirSync(path.dirname(PERF_DONE_OUT_PATH), { recursive: true });
      fs.writeFileSync(
        PERF_DONE_OUT_PATH,
        JSON.stringify(
          {
            status: "ok",
            tracePath,
            interactions,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date(completedAt).toISOString(),
            durationMs: completedAt - startedAt,
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    try {
      tracePath = await contentTracing.stopRecording(PERF_TRACE_OUT_PATH);
    } catch {
      // Ignore errors while attempting to stop a recording that may not have started.
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[desktop-perf] automation failed:", message);
    if (PERF_DONE_OUT_PATH.length > 0) {
      fs.mkdirSync(path.dirname(PERF_DONE_OUT_PATH), { recursive: true });
      fs.writeFileSync(
        PERF_DONE_OUT_PATH,
        JSON.stringify(
          {
            status: "error",
            error: message,
            tracePath,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    }
  }
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        if (port > 0) {
          resolve(port);
          return;
        }
        reject(new Error("Failed to reserve backend port"));
      });
    });
    probe.on("error", reject);
  });
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
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    env: {
      ...backendEnv(),
      ELECTRON_RUN_AS_NODE: "1",
    },
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
    if (!PERF_AUTOMATION_ENABLED) {
      window.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    if (!fs.existsSync(WEB_ENTRY)) {
      throw new Error(`Web bundle missing at ${WEB_ENTRY}`);
    }
    void window.loadFile(WEB_ENTRY);
  }

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

async function bootstrap(): Promise<void> {
  backendPort = await reserveLoopbackPort();
  backendAuthToken = randomBytes(24).toString("hex");
  backendWsUrl = `ws://127.0.0.1:${backendPort}/?token=${encodeURIComponent(backendAuthToken)}`;
  process.env.T3CODE_DESKTOP_WS_URL = backendWsUrl;

  registerIpcHandlers();
  startBackend();
  mainWindow = createWindow();
  if (mainWindow && PERF_AUTOMATION_ENABLED) {
    void runPerfAutomation(mainWindow);
  }
}

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
});

app.whenReady().then(() => {
  void bootstrap();

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
