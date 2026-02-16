import fs from "node:fs";
import path from "node:path";

import { BrowserWindow, contentTracing, type WebContents } from "electron";

const PERF_AUTOMATION_ENABLED = process.env.T3CODE_DESKTOP_PERF_AUTOMATION === "1";
const PERF_TRACE_OUT_PATH = process.env.T3CODE_DESKTOP_PERF_TRACE_OUT?.trim() ?? "";
const PERF_DONE_OUT_PATH = process.env.T3CODE_DESKTOP_PERF_DONE_OUT?.trim() ?? "";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label} (${timeoutMs}ms).`));
    }, timeoutMs);
    timeout.unref();

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function waitForDidFinishLoad(
  webContents: WebContents,
  options?: { timeoutMs?: number; label?: string },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const label = options?.label ?? "renderer load";

  if (!webContents.isLoadingMainFrame()) {
    const currentUrl = webContents.getURL();
    if (currentUrl.length === 0 || currentUrl.startsWith("chrome-error://")) {
      return Promise.reject(
        new Error(`${label} is not loading and no valid page is currently loaded (${currentUrl}).`),
      );
    }
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      webContents.removeListener("did-finish-load", onLoad);
      webContents.removeListener("did-fail-load", onFailLoad);
      clearTimeout(timeout);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onLoad = () => {
      finish(resolve);
    };
    const onFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      finish(() => {
        reject(
          new Error(
            `${label} failed for ${validatedURL || "(unknown url)"} [${errorCode}] ${errorDescription}`,
          ),
        );
      });
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for ${label} (${timeoutMs}ms).`)));
    }, timeoutMs);
    timeout.unref();

    webContents.on("did-fail-load", onFailLoad);
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

const LARGE_THREAD_EXCHANGE_COUNT = 120;

function buildLargeThreadMessage(
  projectName: string,
  exchangeIndex: number,
  role: "user" | "assistant",
): string {
  if (role === "user") {
    return [
      `Large-thread perf scenario ${exchangeIndex + 1} for ${projectName}.`,
      "Please audit render cost while scrolling and switching among heavy histories.",
      "Include hotspots in markdown rendering, timeline grouping, and message list virtualization candidates.",
      "Track regressions across interaction loops and report any long-task spikes.",
    ].join("\n");
  }

  return [
    `### Perf analysis batch ${exchangeIndex + 1}`,
    "",
    "- Checked keypress/input dispatch cost and scheduler churn.",
    "- Compared component update cadence before/after thread switch.",
    "- Captured timeline and branch/tool state snapshots.",
    "",
    "```txt",
    `project=${projectName}`,
    `batch=${exchangeIndex + 1}`,
    "status=stable",
    "focus=render-throughput",
    "```",
    "",
    "Observed stable behavior under bursty UI events; continue profiling for long-thread rendering regressions.",
  ].join("\n");
}

function buildLargePerfThread(project: PerfPersistedProject, now: number): PerfPersistedThread {
  const threadId = `${project.id}-thread-large`;
  const createdAt = new Date(now - 1_500_000).toISOString();
  const messages: PerfPersistedMessage[] = [];
  for (let exchangeIndex = 0; exchangeIndex < LARGE_THREAD_EXCHANGE_COUNT; exchangeIndex += 1) {
    const offsetMs = (LARGE_THREAD_EXCHANGE_COUNT - exchangeIndex) * 11_000;
    messages.push({
      id: `${threadId}-user-${exchangeIndex + 1}`,
      role: "user",
      text: buildLargeThreadMessage(project.name, exchangeIndex, "user"),
      createdAt: new Date(now - offsetMs - 2_000).toISOString(),
      streaming: false,
    });
    messages.push({
      id: `${threadId}-assistant-${exchangeIndex + 1}`,
      role: "assistant",
      text: buildLargeThreadMessage(project.name, exchangeIndex, "assistant"),
      createdAt: new Date(now - offsetMs).toISOString(),
      streaming: false,
    });
  }

  return {
    id: threadId,
    projectId: project.id,
    title: `${project.name} perf large thread`,
    model: "gpt-5-codex",
    terminalOpen: false,
    messages,
    createdAt,
    lastVisitedAt: new Date(now - 1_000_000).toISOString(),
  };
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

  for (const project of projects) {
    threads.push(buildLargePerfThread(project, now));
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
): Promise<{
  threadClicks: number;
  typedChars: number;
  selectedModel: string | null;
  largeThreadRenderStats: { threadId: string; messageCount: number; renderMs: number }[];
}> {
  const script = `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const must = (condition, message) => {
        if (!condition) throw new Error(message);
      };
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitFor = async (predicate, timeoutMs, message) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          if (predicate()) return;
          await nextFrame();
        }
        throw new Error(message);
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

      const measureThreadRender = async (threadId) => {
        const selector = '[data-perf-thread-id="' + threadId + '"]';
        const targetButton = document.querySelector(selector);
        must(targetButton instanceof HTMLElement, "Thread button missing for " + threadId);
        const start = performance.now();
        clickElement(targetButton);
        await waitFor(
          () => {
            const scroller = document.querySelector("[data-perf-messages-scroll]");
            return (
              scroller instanceof HTMLElement &&
              scroller.getAttribute("data-perf-active-thread-id") === threadId
            );
          },
          15_000,
          "Timed out waiting for thread activation " + threadId,
        );
        await nextFrame();
        await nextFrame();
        const scroller = document.querySelector("[data-perf-messages-scroll]");
        const messageCountRaw =
          scroller instanceof HTMLElement ? scroller.getAttribute("data-perf-message-count") : null;
        const messageCount =
          messageCountRaw && /^\\d+$/.test(messageCountRaw) ? Number(messageCountRaw) : 0;
        return {
          threadId,
          messageCount,
          renderMs: Number((performance.now() - start).toFixed(2)),
        };
      };

      const largeThreadRenderStats = [];
      const largeThreadIds = ["perf-project-1-thread-large", "perf-project-2-thread-large"];
      for (const threadId of largeThreadIds) {
        largeThreadRenderStats.push(await measureThreadRender(threadId));
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
        largeThreadRenderStats,
      };
    })();
  `;

  return window.webContents.executeJavaScript(script, true);
}

export async function runDesktopPerfAutomation(window: BrowserWindow): Promise<void> {
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
  let isTraceRecording = false;
  const startedAt = Date.now();
  try {
    console.log("[desktop-perf] waiting for initial load");
    await waitForDidFinishLoad(window.webContents, {
      timeoutMs: 60_000,
      label: "initial load",
    });
    console.log("[desktop-perf] seeding renderer state");
    await seedRendererState(window);
    window.webContents.reload();
    console.log("[desktop-perf] waiting for reload");
    await waitForDidFinishLoad(window.webContents, {
      timeoutMs: 60_000,
      label: "post-seed reload",
    });
    await delay(300);

    fs.mkdirSync(path.dirname(PERF_TRACE_OUT_PATH), { recursive: true });
    console.log("[desktop-perf] starting trace recording");
    await contentTracing.startRecording(traceConfig);
    isTraceRecording = true;
    console.log("[desktop-perf] running scripted interactions");
    const interactions = await runRendererPerfInteractions(window);
    await delay(300);
    console.log("[desktop-perf] stopping trace recording");
    tracePath = await withTimeout(
      contentTracing.stopRecording(PERF_TRACE_OUT_PATH),
      15_000,
      "trace recording to stop",
    );
    isTraceRecording = false;
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
    if (isTraceRecording) {
      try {
        tracePath = await withTimeout(
          contentTracing.stopRecording(PERF_TRACE_OUT_PATH),
          15_000,
          "trace recording to stop after failure",
        );
      } catch (stopError) {
        const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
        console.error("[desktop-perf] failed to stop trace recording:", stopMessage);
      } finally {
        isTraceRecording = false;
      }
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
