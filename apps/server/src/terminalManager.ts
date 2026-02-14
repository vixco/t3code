import { EventEmitter } from "node:events";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalWriteInput,
  terminalClearInputSchema,
  terminalCloseInputSchema,
  terminalOpenInputSchema,
  terminalResizeInputSchema,
  terminalWriteInputSchema,
} from "@t3tools/contracts";

import { createLogger } from "./logger";
import { NodePtyAdapter, type PtyAdapter, type PtyExitEvent, type PtyProcess } from "./ptyAdapter";
import { runProcess } from "./processRunner";

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);
const DEFAULT_WEB_PORT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_WEB_PORT_PROBE_TTL_MS = 10_000;
const WEB_PORT_PROBE_MAX_BODY_BYTES = 8_192;
const MAX_PORT_NUMBER = 65_535;

type TerminalSubprocessChecker = (terminalPid: number) => Promise<boolean>;
type TerminalWebPortInspector = (port: number) => Promise<boolean>;
interface TerminalSubprocessActivity {
  hasRunningSubprocess: boolean;
  runningPorts: number[];
}
type TerminalSubprocessInspector = (
  terminalPid: number,
) => Promise<TerminalSubprocessActivity>;

export interface TerminalManagerEvents {
  event: [event: TerminalEvent];
}

export interface TerminalManagerOptions {
  logsDir?: string;
  historyLineLimit?: number;
  ptyAdapter?: PtyAdapter;
  shellResolver?: () => string;
  subprocessChecker?: TerminalSubprocessChecker;
  subprocessInspector?: TerminalSubprocessInspector;
  webPortInspector?: TerminalWebPortInspector;
  webPortProbeCacheTtlMs?: number;
  subprocessPollIntervalMs?: number;
}

interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  runningSubprocessPorts: number[];
}

function defaultShellResolver(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }
  return process.env.SHELL ?? "bash";
}

function normalizeShellCommand(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (process.platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function uniqueShells(shells: Array<string | null>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const shell of shells) {
    if (!shell || shell.length === 0) continue;
    if (seen.has(shell)) continue;
    seen.add(shell);
    ordered.push(shell);
  }
  return ordered;
}

function resolveShellCandidates(shellResolver: () => string): string[] {
  const requested = normalizeShellCommand(shellResolver());

  if (process.platform === "win32") {
    return uniqueShells([requested, process.env.ComSpec ?? null, "powershell.exe", "cmd.exe"]);
  }

  return uniqueShells([
    requested,
    normalizeShellCommand(process.env.SHELL),
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
    "zsh",
    "bash",
    "sh",
  ]);
}

function isRetryableShellSpawnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

function normalizeRunningPorts(ports: number[]): number[] {
  if (ports.length === 0) return [];
  return [...new Set(ports)]
    .filter((port) => Number.isInteger(port) && port > 0 && port <= MAX_PORT_NUMBER)
    .toSorted((left, right) => left - right);
}

function parsePidList(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    pids.push(pid);
  }
  return [...new Set(pids)];
}

function parsePortList(stdout: string): number[] {
  const ports: number[] = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const port = Number(line.trim());
    if (!Number.isInteger(port)) {
      continue;
    }
    ports.push(port);
  }
  return normalizeRunningPorts(ports);
}

function portFromAddress(address: string): number | null {
  const match = address.match(/:(\d+)$/);
  if (!match?.[1]) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0 || port > MAX_PORT_NUMBER) {
    return null;
  }
  return port;
}

function arePortListsEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

async function collectWindowsChildPids(terminalPid: number): Promise<number[]> {
  const command = [
    `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${terminalPid}" -ErrorAction SilentlyContinue`,
    "if (-not $children) { exit 0 }",
    "$children | Select-Object -ExpandProperty ProcessId",
  ].join("; ");
  try {
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      },
    );
    if (result.code !== 0) {
      return [];
    }
    return parsePidList(result.stdout);
  } catch {
    return [];
  }
}

async function checkWindowsListeningPorts(processIds: number[]): Promise<number[]> {
  if (processIds.length === 0) return [];
  const processFilter = processIds
    .map((pid) => `$_.OwningProcess -eq ${pid}`)
    .join(" -or ");
  const command = [
    "$connections = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue",
    `$matching = $connections | Where-Object { ${processFilter} }`,
    "if (-not $matching) { exit 0 }",
    "$matching | Select-Object -ExpandProperty LocalPort -Unique",
  ].join("; ");
  try {
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 65_536,
        outputMode: "truncate",
      },
    );
    if (result.code !== 0) {
      return [];
    }
    return parsePortList(result.stdout);
  } catch {
    return [];
  }
}

async function collectPosixProcessFamilyPids(terminalPid: number): Promise<number[]> {
  try {
    const psResult = await runProcess("ps", ["-eo", "pid=,ppid="], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 262_144,
      outputMode: "truncate",
    });
    if (psResult.code !== 0) {
      return [];
    }

    const childrenByParentPid = new Map<number, number[]>();
    for (const line of psResult.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      const children = childrenByParentPid.get(ppid);
      if (children) {
        children.push(pid);
      } else {
        childrenByParentPid.set(ppid, [pid]);
      }
    }

    const processFamily = new Set<number>([terminalPid]);
    const pendingParents = [terminalPid];
    while (pendingParents.length > 0) {
      const parentPid = pendingParents.shift();
      if (!parentPid) continue;
      const childPids = childrenByParentPid.get(parentPid);
      if (!childPids || childPids.length === 0) continue;
      for (const childPid of childPids) {
        if (processFamily.has(childPid)) continue;
        processFamily.add(childPid);
        pendingParents.push(childPid);
      }
    }

    return [...processFamily];
  } catch {
    return [];
  }
}

async function checkPosixListeningPorts(processIds: number[]): Promise<number[]> {
  if (processIds.length === 0) return [];

  const ports = new Set<number>();
  const pidFilter = new Set(processIds);

  try {
    const result = await runProcess(
      "lsof",
      ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", processIds.join(",")],
      {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 262_144,
        outputMode: "truncate",
      },
    );
    if (result.code === 0) {
      for (const line of result.stdout.split(/\r?\n/g)) {
        const match = line.match(/:(\d+)\s+\(LISTEN\)$/);
        if (!match?.[1]) continue;
        const port = Number(match[1]);
        if (Number.isInteger(port) && port > 0 && port <= MAX_PORT_NUMBER) {
          ports.add(port);
        }
      }
      return [...ports].toSorted((left, right) => left - right);
    }
  } catch {
    // Fall back to ss if lsof is unavailable.
  }

  try {
    const result = await runProcess("ss", ["-ltnp"], {
      timeoutMs: 1_500,
      allowNonZeroExit: true,
      maxBufferBytes: 524_288,
      outputMode: "truncate",
    });
    if (result.code !== 0) {
      return [];
    }

    for (const line of result.stdout.split(/\r?\n/g)) {
      if (!line.includes("pid=")) continue;
      const localAddress = line.trim().split(/\s+/g)[3];
      if (!localAddress) continue;
      const port = portFromAddress(localAddress);
      if (port === null) continue;

      const pidMatches = [...line.matchAll(/pid=(\d+)/g)];
      if (pidMatches.length === 0) continue;
      if (
        pidMatches.some((match) => {
          const pid = Number(match[1]);
          return Number.isInteger(pid) && pidFilter.has(pid);
        })
      ) {
        ports.add(port);
      }
    }
    return [...ports].toSorted((left, right) => left - right);
  } catch {
    return [];
  }
}

async function defaultSubprocessInspector(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return { hasRunningSubprocess: false, runningPorts: [] };
  }

  if (process.platform === "win32") {
    const childPids = await collectWindowsChildPids(terminalPid);
    if (childPids.length === 0) {
      return { hasRunningSubprocess: false, runningPorts: [] };
    }
    const runningPorts = await checkWindowsListeningPorts(childPids);
    return { hasRunningSubprocess: true, runningPorts };
  }

  const processFamilyPids = await collectPosixProcessFamilyPids(terminalPid);
  const subprocessPids = processFamilyPids.filter((pid) => pid !== terminalPid);
  if (subprocessPids.length === 0) {
    return { hasRunningSubprocess: false, runningPorts: [] };
  }

  const runningPorts = await checkPosixListeningPorts(subprocessPids);
  return { hasRunningSubprocess: true, runningPorts };
}

interface WebProbeResult {
  status: number;
  contentType: string;
  body: string;
  location: string;
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? "";
  return "";
}

function isLikelyWebProbe(result: WebProbeResult | null): boolean {
  if (!result) return false;
  if (result.status === 404) return false;
  if (result.status >= 300 && result.status < 400 && result.location.length > 0) {
    return true;
  }
  const contentType = result.contentType.toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    return true;
  }
  const body = result.body.toLowerCase();
  return (
    body.includes("<!doctype") ||
    body.includes("<html") ||
    body.includes("<head")
  );
}

async function probeWebPortOnHost(
  port: number,
  host: string,
): Promise<WebProbeResult | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const settle = (result: WebProbeResult | null) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const req = httpRequest(
      {
        host,
        port,
        method: "GET",
        path: "/",
        timeout: DEFAULT_WEB_PORT_PROBE_TIMEOUT_MS,
      },
      (res) => {
        const chunks: string[] = [];
        let received = 0;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (received >= WEB_PORT_PROBE_MAX_BODY_BYTES) return;
          const remaining = WEB_PORT_PROBE_MAX_BODY_BYTES - received;
          const fragment = chunk.slice(0, remaining);
          received += fragment.length;
          chunks.push(fragment);
          if (received >= WEB_PORT_PROBE_MAX_BODY_BYTES) {
            res.destroy();
          }
        });
        res.on("end", () => {
          settle({
            status: res.statusCode ?? 0,
            contentType: normalizeHeaderValue(res.headers["content-type"]),
            location: normalizeHeaderValue(res.headers.location),
            body: chunks.join(""),
          });
        });
        res.on("error", () => {
          settle(null);
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      settle(null);
    });
    req.on("error", () => {
      settle(null);
    });

    timer = setTimeout(() => {
      req.destroy();
      settle(null);
    }, DEFAULT_WEB_PORT_PROBE_TIMEOUT_MS + 50);

    req.end();
  });
}

async function defaultWebPortInspector(port: number): Promise<boolean> {
  const ipv4Result = await probeWebPortOnHost(port, "127.0.0.1");
  if (isLikelyWebProbe(ipv4Result)) {
    return true;
  }
  const ipv6Result = await probeWebPortOnHost(port, "::1");
  return isLikelyWebProbe(ipv6Result);
}

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Buffer.from(threadId, "utf8").toString("base64url")}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Buffer.from(terminalId, "utf8").toString("base64url");
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

function createTerminalSpawnEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  return spawnEnv;
}

export class TerminalManager extends EventEmitter<TerminalManagerEvents> {
  private readonly sessions = new Map<string, TerminalSessionState>();
  private readonly logsDir: string;
  private readonly historyLineLimit: number;
  private readonly ptyAdapter: PtyAdapter;
  private readonly shellResolver: () => string;
  private readonly persistQueues = new Map<string, Promise<void>>();
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingPersistHistory = new Map<string, string>();
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly persistDebounceMs: number;
  private readonly subprocessInspector: TerminalSubprocessInspector;
  private readonly webPortInspector: TerminalWebPortInspector;
  private readonly webPortProbeCacheTtlMs: number;
  private readonly webPortProbeCache = new Map<
    number,
    { isWeb: boolean; checkedAt: number }
  >();
  private readonly webPortProbeInFlight = new Map<number, Promise<boolean>>();
  private readonly subprocessPollIntervalMs: number;
  private subprocessPollTimer: ReturnType<typeof setInterval> | null = null;
  private subprocessPollInFlight = false;
  private readonly logger = createLogger("terminal");

  constructor(options: TerminalManagerOptions = {}) {
    super();
    this.logsDir = options.logsDir ?? path.resolve(process.cwd(), ".logs", "terminals");
    this.historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    this.ptyAdapter = options.ptyAdapter ?? new NodePtyAdapter();
    this.shellResolver = options.shellResolver ?? defaultShellResolver;
    this.persistDebounceMs = DEFAULT_PERSIST_DEBOUNCE_MS;
    this.subprocessInspector =
      options.subprocessInspector ??
      (options.subprocessChecker
        ? async (terminalPid: number) => ({
            hasRunningSubprocess: await options.subprocessChecker!(terminalPid),
            runningPorts: [],
          })
        : defaultSubprocessInspector);
    this.webPortInspector = options.webPortInspector ?? defaultWebPortInspector;
    this.webPortProbeCacheTtlMs =
      options.webPortProbeCacheTtlMs ?? DEFAULT_WEB_PORT_PROBE_TTL_MS;
    this.subprocessPollIntervalMs =
      options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  async open(raw: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const input = terminalOpenInputSchema.parse(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);

      const sessionKey = toSessionKey(input.threadId, input.terminalId);
      const existing = this.sessions.get(sessionKey);
      if (!existing) {
        await this.flushPersistQueue(input.threadId, input.terminalId);
        const history = await this.readHistory(input.threadId, input.terminalId);
        const session: TerminalSessionState = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history,
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
          cols: input.cols,
          rows: input.rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          runningSubprocessPorts: [],
        };
        this.sessions.set(sessionKey, session);
        this.startSession(session, input, "started");
        return this.snapshot(session);
      }

      if (existing.cwd !== input.cwd) {
        this.stopProcess(existing);
        existing.cwd = input.cwd;
        existing.history = "";
        await this.persistHistory(existing.threadId, existing.terminalId, existing.history);
      } else if (existing.status === "exited" || existing.status === "error") {
        existing.history = "";
        await this.persistHistory(existing.threadId, existing.terminalId, existing.history);
      }

      if (!existing.process) {
        this.startSession(existing, input, "started");
        return this.snapshot(existing);
      }

      if (existing.cols !== input.cols || existing.rows !== input.rows) {
        existing.cols = input.cols;
        existing.rows = input.rows;
        existing.process.resize(input.cols, input.rows);
        existing.updatedAt = new Date().toISOString();
      }

      return this.snapshot(existing);
    });
  }

  async write(raw: TerminalWriteInput): Promise<void> {
    const input = terminalWriteInputSchema.parse(raw);
    const session = this.requireSession(input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    session.process.write(input.data);
  }

  async resize(raw: TerminalResizeInput): Promise<void> {
    const input = terminalResizeInputSchema.parse(raw);
    const session = this.requireSession(input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    session.cols = input.cols;
    session.rows = input.rows;
    session.updatedAt = new Date().toISOString();
    session.process.resize(input.cols, input.rows);
  }

  async clear(raw: TerminalClearInput): Promise<void> {
    const input = terminalClearInputSchema.parse(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      const session = this.requireSession(input.threadId, input.terminalId);
      session.history = "";
      session.updatedAt = new Date().toISOString();
      await this.persistHistory(input.threadId, input.terminalId, session.history);
      this.emitEvent({
        type: "cleared",
        threadId: input.threadId,
        terminalId: input.terminalId,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async restart(raw: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const input = terminalOpenInputSchema.parse(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);

      const sessionKey = toSessionKey(input.threadId, input.terminalId);
      let session = this.sessions.get(sessionKey);
      if (!session) {
        session = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
          cols: input.cols,
          rows: input.rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          runningSubprocessPorts: [],
        };
        this.sessions.set(sessionKey, session);
      } else {
        this.stopProcess(session);
        session.cwd = input.cwd;
      }

      session.history = "";
      await this.persistHistory(input.threadId, input.terminalId, session.history);
      this.startSession(session, input, "restarted");
      return this.snapshot(session);
    });
  }

  async close(raw: TerminalCloseInput): Promise<void> {
    const input = terminalCloseInputSchema.parse(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      if (input.terminalId) {
        await this.closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
        return;
      }

      const threadSessions = this.sessionsForThread(input.threadId);
      for (const session of threadSessions) {
        this.stopProcess(session);
        this.sessions.delete(toSessionKey(session.threadId, session.terminalId));
      }
      await Promise.all(
        threadSessions.map((session) =>
          this.flushPersistQueue(session.threadId, session.terminalId),
        ),
      );

      if (input.deleteHistory) {
        await this.deleteAllHistoryForThread(input.threadId);
      }
      this.updateSubprocessPollingState();
    });
  }

  dispose(): void {
    this.stopSubprocessPolling();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      this.stopProcess(session);
    }
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }
    this.persistTimers.clear();
    this.pendingPersistHistory.clear();
    this.threadLocks.clear();
    this.persistQueues.clear();
    this.webPortProbeCache.clear();
    this.webPortProbeInFlight.clear();
  }

  private startSession(
    session: TerminalSessionState,
    input: TerminalOpenInput,
    eventType: "started" | "restarted",
  ): void {
    this.stopProcess(session);

    session.status = "starting";
    session.cwd = input.cwd;
    session.cols = input.cols;
    session.rows = input.rows;
    session.exitCode = null;
    session.exitSignal = null;
    session.hasRunningSubprocess = false;
    session.runningSubprocessPorts = [];
    session.updatedAt = new Date().toISOString();

    let ptyProcess: PtyProcess | null = null;
    let startedShell: string | null = null;
    try {
      const shellCandidates = resolveShellCandidates(this.shellResolver);
      const terminalEnv = createTerminalSpawnEnv(process.env);
      let lastSpawnError: unknown = null;

      for (const shell of shellCandidates) {
        try {
          ptyProcess = this.ptyAdapter.spawn({
            shell,
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            env: terminalEnv,
          });
          startedShell = shell;
          break;
        } catch (error) {
          lastSpawnError = error;
          if (!isRetryableShellSpawnError(error)) {
            throw error;
          }
        }
      }

      if (!ptyProcess) {
        const detail =
          lastSpawnError instanceof Error ? lastSpawnError.message : "Terminal start failed";
        const tried =
          shellCandidates.length > 0 ? ` Tried shells: ${shellCandidates.join(", ")}.` : "";
        throw new Error(`${detail}.${tried}`.trim());
      }

      session.process = ptyProcess;
      session.pid = ptyProcess.pid;
      session.status = "running";
      session.updatedAt = new Date().toISOString();
      session.unsubscribeData = ptyProcess.onData((data) => {
        this.onProcessData(session, data);
      });
      session.unsubscribeExit = ptyProcess.onExit((event) => {
        this.onProcessExit(session, event);
      });
      this.updateSubprocessPollingState();
      this.emitEvent({
        type: eventType,
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        snapshot: this.snapshot(session),
      });
    } catch (error) {
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {
          // Ignore kill errors during failed startup cleanup.
        }
      }
      session.status = "error";
      session.pid = null;
      session.process = null;
      session.hasRunningSubprocess = false;
      session.runningSubprocessPorts = [];
      session.updatedAt = new Date().toISOString();
      this.updateSubprocessPollingState();
      const message = error instanceof Error ? error.message : "Terminal start failed";
      this.emitEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        message,
      });
      this.logger.error("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: message,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  }

  private onProcessData(session: TerminalSessionState, data: string): void {
    session.history = capHistory(`${session.history}${data}`, this.historyLineLimit);
    session.updatedAt = new Date().toISOString();
    this.queuePersist(session.threadId, session.terminalId, session.history);
    this.emitEvent({
      type: "output",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      data,
    });
  }

  private onProcessExit(session: TerminalSessionState, event: PtyExitEvent): void {
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.hasRunningSubprocess = false;
    session.runningSubprocessPorts = [];
    session.status = "exited";
    session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
    session.exitSignal = Number.isInteger(event.signal) ? event.signal : null;
    session.updatedAt = new Date().toISOString();
    this.emitEvent({
      type: "exited",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
    });
    this.updateSubprocessPollingState();
  }

  private stopProcess(session: TerminalSessionState): void {
    const process = session.process;
    if (!process) return;
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.hasRunningSubprocess = false;
    session.runningSubprocessPorts = [];
    session.status = "exited";
    session.updatedAt = new Date().toISOString();
    try {
      process.kill();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("failed to kill terminal process", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: message,
      });
    }
    this.updateSubprocessPollingState();
  }

  private cleanupProcessHandles(session: TerminalSessionState): void {
    session.unsubscribeData?.();
    session.unsubscribeData = null;
    session.unsubscribeExit?.();
    session.unsubscribeExit = null;
  }

  private queuePersist(threadId: string, terminalId: string, history: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.pendingPersistHistory.set(persistenceKey, history);
    this.schedulePersist(threadId, terminalId);
  }

  private async persistHistory(
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);
    this.pendingPersistHistory.delete(persistenceKey);
    await this.enqueuePersistWrite(threadId, terminalId, history);
  }

  private enqueuePersistWrite(
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const task = async () => {
      await fs.promises.writeFile(this.historyPath(threadId, terminalId), history, "utf8");
    };
    const previous = this.persistQueues.get(persistenceKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.logger.warn("failed to persist terminal history", {
          threadId,
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.persistQueues.set(persistenceKey, next);
    const finalized = next.finally(() => {
      if (this.persistQueues.get(persistenceKey) === next) {
        this.persistQueues.delete(persistenceKey);
      }
      if (
        this.pendingPersistHistory.has(persistenceKey) &&
        !this.persistTimers.has(persistenceKey)
      ) {
        this.schedulePersist(threadId, terminalId);
      }
    });
    void finalized.catch(() => undefined);
    return finalized;
  }

  private schedulePersist(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    if (this.persistTimers.has(persistenceKey)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(persistenceKey);
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory === undefined) return;
      this.pendingPersistHistory.delete(persistenceKey);
      void this.enqueuePersistWrite(threadId, terminalId, pendingHistory);
    }, this.persistDebounceMs);
    this.persistTimers.set(persistenceKey, timer);
  }

  private clearPersistTimer(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const timer = this.persistTimers.get(persistenceKey);
    if (!timer) return;
    clearTimeout(timer);
    this.persistTimers.delete(persistenceKey);
  }

  private async readHistory(threadId: string, terminalId: string): Promise<string> {
    const nextPath = this.historyPath(threadId, terminalId);
    try {
      const raw = await fs.promises.readFile(nextPath, "utf8");
      const capped = capHistory(raw, this.historyLineLimit);
      if (capped !== raw) {
        await fs.promises.writeFile(nextPath, capped, "utf8");
      }
      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return "";
    }

    const legacyPath = this.legacyHistoryPath(threadId);
    try {
      const raw = await fs.promises.readFile(legacyPath, "utf8");
      const capped = capHistory(raw, this.historyLineLimit);

      // Migrate legacy transcript filename to the terminal-scoped path.
      await fs.promises.writeFile(nextPath, capped, "utf8");
      try {
        await fs.promises.rm(legacyPath, { force: true });
      } catch (cleanupError) {
        this.logger.warn("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }

      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  private async deleteHistory(threadId: string, terminalId: string): Promise<void> {
    const deletions = [fs.promises.rm(this.historyPath(threadId, terminalId), { force: true })];
    if (terminalId === DEFAULT_TERMINAL_ID) {
      deletions.push(fs.promises.rm(this.legacyHistoryPath(threadId), { force: true }));
    }
    try {
      await Promise.all(deletions);
    } catch (error) {
      this.logger.warn("failed to delete terminal history", {
        threadId,
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async flushPersistQueue(threadId: string, terminalId: string): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);

    while (true) {
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory !== undefined) {
        this.pendingPersistHistory.delete(persistenceKey);
        await this.enqueuePersistWrite(threadId, terminalId, pendingHistory);
      }

      const pending = this.persistQueues.get(persistenceKey);
      if (!pending) {
        return;
      }
      await pending.catch(() => undefined);
    }
  }

  private updateSubprocessPollingState(): void {
    const hasRunningSessions = [...this.sessions.values()].some(
      (session) => session.status === "running" && session.pid !== null,
    );
    if (hasRunningSessions) {
      this.ensureSubprocessPolling();
      return;
    }
    this.stopSubprocessPolling();
  }

  private ensureSubprocessPolling(): void {
    if (this.subprocessPollTimer) return;
    this.subprocessPollTimer = setInterval(() => {
      void this.pollSubprocessActivity();
    }, this.subprocessPollIntervalMs);
    this.subprocessPollTimer.unref?.();
    void this.pollSubprocessActivity();
  }

  private stopSubprocessPolling(): void {
    if (!this.subprocessPollTimer) return;
    clearInterval(this.subprocessPollTimer);
    this.subprocessPollTimer = null;
  }

  private async inspectWebPortCached(port: number): Promise<boolean> {
    const now = Date.now();
    const cached = this.webPortProbeCache.get(port);
    if (cached && now - cached.checkedAt <= this.webPortProbeCacheTtlMs) {
      return cached.isWeb;
    }

    const inFlight = this.webPortProbeInFlight.get(port);
    if (inFlight) {
      return inFlight;
    }

    const probe = this.webPortInspector(port)
      .then((isWeb) => {
        this.webPortProbeCache.set(port, {
          isWeb,
          checkedAt: Date.now(),
        });
        return isWeb;
      })
      .catch(() => false)
      .finally(() => {
        this.webPortProbeInFlight.delete(port);
      });
    this.webPortProbeInFlight.set(port, probe);
    return probe;
  }

  private async detectWebPorts(runningPorts: number[]): Promise<number[]> {
    if (runningPorts.length === 0) return [];
    const checks = await Promise.all(
      runningPorts.map(async (port) => ({
        port,
        isWeb: await this.inspectWebPortCached(port),
      })),
    );
    return checks
      .filter((entry) => entry.isWeb)
      .map((entry) => entry.port)
      .toSorted((left, right) => left - right);
  }

  private async pollSubprocessActivity(): Promise<void> {
    if (this.subprocessPollInFlight) return;

    const runningSessions = [...this.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );
    if (runningSessions.length === 0) {
      this.stopSubprocessPolling();
      return;
    }

    this.subprocessPollInFlight = true;
    try {
      await Promise.all(
        runningSessions.map(async (session) => {
          const terminalPid = session.pid;
          let activity: TerminalSubprocessActivity = {
            hasRunningSubprocess: false,
            runningPorts: [],
          };
          try {
            activity = await this.subprocessInspector(terminalPid);
          } catch (error) {
            this.logger.warn("failed to check terminal subprocess activity", {
              threadId: session.threadId,
              terminalId: session.terminalId,
              terminalPid,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          const liveSession = this.sessions.get(toSessionKey(session.threadId, session.terminalId));
          if (!liveSession || liveSession.status !== "running" || liveSession.pid !== terminalPid) {
            return;
          }
          const hasRunningSubprocess = activity.hasRunningSubprocess === true;
          const runningPorts = hasRunningSubprocess
            ? normalizeRunningPorts(
                await this.detectWebPorts(normalizeRunningPorts(activity.runningPorts)),
              )
            : [];
          if (
            liveSession.hasRunningSubprocess === hasRunningSubprocess &&
            arePortListsEqual(liveSession.runningSubprocessPorts, runningPorts)
          ) {
            return;
          }

          liveSession.hasRunningSubprocess = hasRunningSubprocess;
          liveSession.runningSubprocessPorts = runningPorts;
          liveSession.updatedAt = new Date().toISOString();
          this.emitEvent({
            type: "activity",
            threadId: liveSession.threadId,
            terminalId: liveSession.terminalId,
            createdAt: new Date().toISOString(),
            hasRunningSubprocess,
            runningPorts,
          });
        }),
      );
    } finally {
      this.subprocessPollInFlight = false;
    }
  }

  private async assertValidCwd(cwd: string): Promise<void> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Terminal cwd does not exist: ${cwd}`, { cause: error });
      }
      throw error;
    }
    if (!stats.isDirectory()) {
      throw new Error(`Terminal cwd is not a directory: ${cwd}`);
    }
  }

  private async closeSession(
    threadId: string,
    terminalId: string,
    deleteHistory: boolean,
  ): Promise<void> {
    const key = toSessionKey(threadId, terminalId);
    const session = this.sessions.get(key);
    if (session) {
      this.stopProcess(session);
      this.sessions.delete(key);
    }
    this.updateSubprocessPollingState();
    await this.flushPersistQueue(threadId, terminalId);
    if (deleteHistory) {
      await this.deleteHistory(threadId, terminalId);
    }
  }

  private sessionsForThread(threadId: string): TerminalSessionState[] {
    return [...this.sessions.values()].filter((session) => session.threadId === threadId);
  }

  private async deleteAllHistoryForThread(threadId: string): Promise<void> {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    try {
      const entries = await fs.promises.readdir(this.logsDir, { withFileTypes: true });
      const removals = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter(
          (name) =>
            name === `${toSafeThreadId(threadId)}.log` ||
            name === `${legacySafeThreadId(threadId)}.log` ||
            name.startsWith(threadPrefix),
        )
        .map((name) => fs.promises.rm(path.join(this.logsDir, name), { force: true }));
      await Promise.all(removals);
    } catch (error) {
      this.logger.warn("failed to delete terminal histories for thread", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requireSession(threadId: string, terminalId: string): TerminalSessionState {
    const session = this.sessions.get(toSessionKey(threadId, terminalId));
    if (!session) {
      throw new Error(`Unknown terminal thread: ${threadId}, terminal: ${terminalId}`);
    }
    return session;
  }

  private snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
    return {
      threadId: session.threadId,
      terminalId: session.terminalId,
      cwd: session.cwd,
      status: session.status,
      pid: session.pid,
      history: session.history,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      updatedAt: session.updatedAt,
    };
  }

  private emitEvent(event: TerminalEvent): void {
    this.emit("event", event);
  }

  private historyPath(threadId: string, terminalId: string): string {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(this.logsDir, `${threadPart}.log`);
    }
    return path.join(this.logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
  }

  private legacyHistoryPath(threadId: string): string {
    return path.join(this.logsDir, `${legacySafeThreadId(threadId)}.log`);
  }

  private async runWithThreadLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.threadLocks.get(threadId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadLocks.set(threadId, current);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.threadLocks.get(threadId) === current) {
        this.threadLocks.delete(threadId);
      }
    }
  }
}
