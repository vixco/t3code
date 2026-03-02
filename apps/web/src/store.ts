import {
  type Dispatch,
  type ReactNode,
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
} from "react";

import {
  DEFAULT_MODEL,
  ProviderSessionId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
  resolveModelSlug,
} from "@t3tools/contracts";
import {
  createDefaultThreadTerminalState,
  normalizeThreadTerminalState,
  reduceThreadTerminalState,
  type ThreadTerminalState,
} from "./threadTerminalState";
import {
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  type Project,
  type RuntimeMode,
  type Thread,
} from "./types";

// ── Actions ──────────────────────────────────────────────────────────

type Action =
  | { type: "SYNC_SERVER_READ_MODEL"; readModel: OrchestrationReadModel }
  | { type: "HYDRATE_THREAD_TERMINALS"; threadId: ThreadId; terminalState: ThreadTerminalState }
  | { type: "MARK_THREAD_VISITED"; threadId: ThreadId; visitedAt?: string }
  | { type: "MARK_THREAD_UNREAD"; threadId: ThreadId }
  | { type: "TOGGLE_PROJECT"; projectId: Project["id"] }
  | {
      type: "SET_THREAD_TERMINAL_ACTIVITY";
      threadId: ThreadId;
      terminalId: string;
      hasRunningSubprocess: boolean;
    }
  | { type: "SET_PROJECT_EXPANDED"; projectId: Project["id"]; expanded: boolean }
  | { type: "TOGGLE_THREAD_TERMINAL"; threadId: ThreadId }
  | { type: "SET_THREAD_TERMINAL_OPEN"; threadId: ThreadId; open: boolean }
  | { type: "SET_THREAD_TERMINAL_HEIGHT"; threadId: ThreadId; height: number }
  | { type: "SPLIT_THREAD_TERMINAL"; threadId: ThreadId; terminalId: string }
  | { type: "NEW_THREAD_TERMINAL"; threadId: ThreadId; terminalId: string }
  | { type: "SET_THREAD_ACTIVE_TERMINAL"; threadId: ThreadId; terminalId: string }
  | { type: "CLOSE_THREAD_TERMINAL"; threadId: ThreadId; terminalId: string }
  | { type: "SET_ERROR"; threadId: ThreadId; error: string | null }
  | {
      type: "SET_THREAD_BRANCH";
      threadId: ThreadId;
      branch: string | null;
      worktreePath: string | null;
    }
  | { type: "SET_RUNTIME_MODE"; mode: RuntimeMode };

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  threadsHydrated: boolean;
  runtimeMode: RuntimeMode;
}

const PERSISTED_STATE_KEY = "t3code:renderer-state:v7";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

const initialState: AppState = {
  projects: [],
  threads: [],
  threadsHydrated: false,
  runtimeMode: DEFAULT_RUNTIME_MODE,
};
const persistedExpandedProjectCwds = new Set<string>();

// ── Helpers ──────────────────────────────────────────────────────────

function readPersistedState(): AppState {
  if (typeof window === "undefined") return initialState;

  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as {
      runtimeMode?: RuntimeMode;
      expandedProjectCwds?: string[];
    };
    persistedExpandedProjectCwds.clear();
    for (const cwd of parsed.expandedProjectCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedExpandedProjectCwds.add(cwd);
      }
    }
    return {
      ...initialState,
      runtimeMode:
        parsed.runtimeMode === "approval-required" || parsed.runtimeMode === "full-access"
          ? parsed.runtimeMode
          : DEFAULT_RUNTIME_MODE,
    };
  } catch {
    return initialState;
  }
}

function persistState(state: AppState): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        runtimeMode: state.runtimeMode,
        expandedProjectCwds: state.projects
          .filter((project) => project.expanded)
          .map((project) => project.cwd),
      }),
    );
    for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
      window.localStorage.removeItem(legacyKey);
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  return threads.map((t) => (t.id === threadId ? updater(t) : t));
}

function mapProjectsFromReadModel(
  incoming: OrchestrationReadModel["projects"],
  previous: Project[],
): Project[] {
  return incoming.map((project) => {
    const existing =
      previous.find((entry) => entry.id === project.id) ??
      previous.find((entry) => entry.cwd === project.workspaceRoot);
    return {
      id: project.id,
      name: project.title,
      cwd: project.workspaceRoot,
      model: existing?.model ?? resolveModelSlug(project.defaultModel ?? DEFAULT_MODEL),
      expanded:
        existing?.expanded ??
        (persistedExpandedProjectCwds.size > 0
          ? persistedExpandedProjectCwds.has(project.workspaceRoot)
          : true),
      scripts: project.scripts.map((script) => ({ ...script })),
    };
  });
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): "codex" | "claudeCode" {
  return providerName === "claudeCode" ? "claudeCode" : "codex";
}

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) {
    return window.location.origin;
  }

  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:"
        ? "https:"
        : wsUrl.protocol === "ws:"
          ? "http:"
          : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

function threadTerminalSlice(thread: Thread): ThreadTerminalState {
  return {
    terminalOpen: thread.terminalOpen,
    terminalHeight: thread.terminalHeight,
    terminalIds: thread.terminalIds,
    runningTerminalIds: thread.runningTerminalIds,
    activeTerminalId: thread.activeTerminalId,
    terminalGroups: thread.terminalGroups,
    activeTerminalGroupId: thread.activeTerminalGroupId,
  };
}

function applyTerminalState(thread: Thread, terminal: ThreadTerminalState): Thread {
  return { ...thread, ...terminal };
}

function normalizeThreadTerminals(thread: Thread): Thread {
  return applyTerminalState(thread, normalizeThreadTerminalState(threadTerminalSlice(thread)));
}

// ── Reducer ──────────────────────────────────────────────────────────

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SYNC_SERVER_READ_MODEL": {
      const projects = mapProjectsFromReadModel(
        action.readModel.projects.filter((project) => project.deletedAt === null),
        state.projects,
      );
      const existingThreadById = new Map(
        state.threads.map((thread) => [thread.id, thread] as const),
      );
      const defaultTerminal = createDefaultThreadTerminalState();
      const threads = action.readModel.threads
        .filter((thread) => thread.deletedAt === null)
        .map((thread) => {
          const existing = existingThreadById.get(thread.id);
          const terminalSlice: ThreadTerminalState = existing
            ? threadTerminalSlice(existing)
            : defaultTerminal;

          return normalizeThreadTerminals({
            id: thread.id,
            codexThreadId: thread.session?.providerThreadId ?? null,
            projectId: thread.projectId,
            title: thread.title,
            model: resolveModelSlug(thread.model),
            ...terminalSlice,
            session: thread.session
              ? {
                  sessionId:
                    thread.session.providerSessionId ??
                    ProviderSessionId.makeUnsafe(`thread:${thread.id}`),
                  provider: toLegacyProvider(thread.session.providerName),
                  status: toLegacySessionStatus(thread.session.status),
                  orchestrationStatus: thread.session.status,
                  threadId: thread.session.providerThreadId,
                  activeTurnId: thread.session.activeTurnId ?? undefined,
                  createdAt: thread.session.updatedAt,
                  updatedAt: thread.session.updatedAt,
                  ...(thread.session.lastError ? { lastError: thread.session.lastError } : {}),
                }
              : null,
            messages: thread.messages.map((message) => {
              const attachments = message.attachments?.map((attachment) => ({
                type: "image" as const,
                id: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
              }));
              const normalizedMessage: ChatMessage = {
                id: message.id,
                role: message.role,
                text: message.text,
                createdAt: message.createdAt,
                streaming: message.streaming,
                ...(message.streaming ? {} : { completedAt: message.updatedAt }),
                ...(attachments && attachments.length > 0 ? { attachments } : {}),
              };
              return normalizedMessage;
            }),
            error: thread.session?.lastError ?? null,
            createdAt: thread.createdAt,
            latestTurn: thread.latestTurn,
            lastVisitedAt: existing?.lastVisitedAt ?? thread.updatedAt,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            turnDiffSummaries: thread.checkpoints.map((checkpoint) => ({
              turnId: checkpoint.turnId,
              completedAt: checkpoint.completedAt,
              status: checkpoint.status,
              assistantMessageId: checkpoint.assistantMessageId ?? undefined,
              checkpointTurnCount: checkpoint.checkpointTurnCount,
              checkpointRef: checkpoint.checkpointRef,
              files: checkpoint.files.map((file) => ({ ...file })),
            })),
            activities: thread.activities.map((activity) => ({ ...activity })),
          });
        });
      return {
        ...state,
        projects,
        threads,
        threadsHydrated: true,
      };
    }

    case "HYDRATE_THREAD_TERMINALS":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) =>
          applyTerminalState(thread, normalizeThreadTerminalState(action.terminalState)),
        ),
      };

    case "MARK_THREAD_VISITED": {
      const visitedAt = action.visitedAt ?? new Date().toISOString();
      const visitedAtMs = Date.parse(visitedAt);
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) => {
          const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
          if (
            Number.isFinite(previousVisitedAtMs) &&
            Number.isFinite(visitedAtMs) &&
            previousVisitedAtMs >= visitedAtMs
          ) {
            return thread;
          }
          return {
            ...thread,
            lastVisitedAt: visitedAt,
          };
        }),
      };
    }

    case "MARK_THREAD_UNREAD": {
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) => {
          if (!thread.latestTurn?.completedAt) {
            return thread;
          }
          const latestTurnCompletedAtMs = Date.parse(thread.latestTurn.completedAt);
          if (Number.isNaN(latestTurnCompletedAtMs)) {
            return thread;
          }
          const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
          if (thread.lastVisitedAt === unreadVisitedAt) {
            return thread;
          }
          return {
            ...thread,
            lastVisitedAt: unreadVisitedAt,
          };
        }),
      };
    }

    case "TOGGLE_PROJECT":
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.projectId ? { ...p, expanded: !p.expanded } : p,
        ),
      };

    case "SET_THREAD_TERMINAL_ACTIVITY":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) =>
          applyTerminalState(
            thread,
            reduceThreadTerminalState(threadTerminalSlice(thread), {
              type: "set-activity",
              terminalId: action.terminalId,
              hasRunningSubprocess: action.hasRunningSubprocess,
            }),
          ),
        ),
      };

    case "SET_PROJECT_EXPANDED":
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.projectId ? { ...p, expanded: action.expanded } : p,
        ),
      };

    case "TOGGLE_THREAD_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) =>
          applyTerminalState(
            thread,
            reduceThreadTerminalState(threadTerminalSlice(thread), {
              type: "set-open",
              open: !thread.terminalOpen,
            }),
          ),
        ),
      };

    case "SET_THREAD_TERMINAL_OPEN":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) =>
          applyTerminalState(
            thread,
            reduceThreadTerminalState(threadTerminalSlice(thread), {
              type: "set-open",
              open: action.open,
            }),
          ),
        ),
      };

    case "SET_THREAD_TERMINAL_HEIGHT":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) =>
          applyTerminalState(
            thread,
            reduceThreadTerminalState(threadTerminalSlice(thread), {
              type: "set-height",
              height: action.height,
            }),
          ),
        ),
      };

    case "SPLIT_THREAD_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) =>
          applyTerminalState(
            thread,
            reduceThreadTerminalState(threadTerminalSlice(thread), {
              type: "split",
              terminalId: action.terminalId,
            }),
          ),
        ),
      };

    case "NEW_THREAD_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) =>
          applyTerminalState(
            thread,
            reduceThreadTerminalState(threadTerminalSlice(thread), {
              type: "new",
              terminalId: action.terminalId,
            }),
          ),
        ),
      };

    case "SET_THREAD_ACTIVE_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) =>
          applyTerminalState(
            thread,
            reduceThreadTerminalState(threadTerminalSlice(thread), {
              type: "set-active",
              terminalId: action.terminalId,
            }),
          ),
        ),
      };

    case "CLOSE_THREAD_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) =>
          applyTerminalState(
            thread,
            reduceThreadTerminalState(threadTerminalSlice(thread), {
              type: "close",
              terminalId: action.terminalId,
            }),
          ),
        ),
      };

    case "SET_ERROR":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          error: action.error,
        })),
      };

    case "SET_THREAD_BRANCH": {
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => {
          // When the effective cwd changes (worktreePath differs), the old
          // session is no longer valid — clear it so ensureSession creates a
          // new one with the correct cwd on the next message.
          const cwdChanged = t.worktreePath !== action.worktreePath;
          return {
            ...t,
            branch: action.branch,
            worktreePath: action.worktreePath,
            ...(cwdChanged ? { session: null } : {}),
          };
        }),
      };
    }

    case "SET_RUNTIME_MODE":
      return {
        ...state,
        runtimeMode: action.mode,
      };

    default:
      return state;
  }
}

// ── Context ──────────────────────────────────────────────────────────

const StoreContext = createContext<{
  state: AppState;
  dispatch: Dispatch<Action>;
}>({ state: initialState, dispatch: () => {} });

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, readPersistedState);

  useEffect(() => {
    persistState(state);
  }, [state]);

  return createElement(StoreContext.Provider, { value: { state, dispatch } }, children);
}

export function useStore() {
  return useContext(StoreContext);
}
