import { Fragment, type ReactNode, createElement, useEffect } from "react";
import {
  DEFAULT_MODEL,
  ProjectId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
  resolveModelSlug,
} from "@t3tools/contracts";
import { create } from "zustand";
import {
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  type Project,
  type RuntimeMode,
  type Thread,
} from "./types";
import { resolveServerHttpOrigin } from "./lib/serverOrigin";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  projectOrder: Project["id"][];
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
  projectOrder: [],
  threads: [],
  threadsHydrated: false,
  runtimeMode: DEFAULT_RUNTIME_MODE,
};
const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrder: Project["id"][] = [];

// ── Persist helpers ──────────────────────────────────────────────────

function readPersistedState(): AppState {
  persistedExpandedProjectCwds.clear();
  persistedProjectOrder.length = 0;
  if (typeof window === "undefined") return initialState;
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as {
      runtimeMode?: RuntimeMode;
      expandedProjectCwds?: string[];
      projectOrder?: string[];
    };
    for (const cwd of parsed.expandedProjectCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedExpandedProjectCwds.add(cwd);
      }
    }
    for (const projectId of parsed.projectOrder ?? []) {
      if (typeof projectId === "string" && projectId.length > 0) {
        persistedProjectOrder.push(ProjectId.makeUnsafe(projectId));
      }
    }
    return {
      ...initialState,
      projectOrder: [...persistedProjectOrder],
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
        projectOrder: state.projects.map((project) => project.id),
      }),
    );
    for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
      window.localStorage.removeItem(legacyKey);
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
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

function applyProjectOrder(projects: Project[], projectOrder: Project["id"][]): Project[] {
  if (projects.length < 2 || projectOrder.length === 0) {
    return projects;
  }

  const remainingProjects = new Map(projects.map((project) => [project.id, project] as const));
  const orderedProjects: Project[] = [];
  for (const projectId of projectOrder) {
    const project = remainingProjects.get(projectId);
    if (!project) continue;
    orderedProjects.push(project);
    remainingProjects.delete(projectId);
  }

  const nextProjects = [
    ...orderedProjects,
    ...projects.filter((project) => remainingProjects.has(project.id)),
  ];
  const orderChanged = nextProjects.some((project, index) => project !== projects[index]);
  return orderChanged ? nextProjects : projects;
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

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveServerHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(
  state: AppState,
  readModel: OrchestrationReadModel,
): AppState {
  const activeReadModelProjects = readModel.projects.filter((project) => project.deletedAt === null);
  const projects = applyProjectOrder(
    mapProjectsFromReadModel(activeReadModelProjects, state.projects),
    state.projectOrder,
  );
  const existingThreadById = new Map(
    state.threads.map((thread) => [thread.id, thread] as const),
  );
  const threads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      const existing = existingThreadById.get(thread.id);
      return {
        id: thread.id,
        codexThreadId: thread.session?.providerThreadId ?? null,
        projectId: thread.projectId,
        title: thread.title,
        model: resolveModelSlug(thread.model),
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
      };
    });
  return {
    ...state,
    projects,
    projectOrder: projects.map((project) => project.id),
    threads,
    threadsHydrated: true,
  };
}

export function markThreadVisited(
  state: AppState,
  threadId: ThreadId,
  visitedAt?: string,
): AppState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const threads = updateThread(state.threads, threadId, (thread) => {
    const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
    if (
      Number.isFinite(previousVisitedAtMs) &&
      Number.isFinite(visitedAtMs) &&
      previousVisitedAtMs >= visitedAtMs
    ) {
      return thread;
    }
    return { ...thread, lastVisitedAt: at };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function markThreadUnread(state: AppState, threadId: ThreadId): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => {
    if (!thread.latestTurn?.completedAt) return thread;
    const latestTurnCompletedAtMs = Date.parse(thread.latestTurn.completedAt);
    if (Number.isNaN(latestTurnCompletedAtMs)) return thread;
    const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
    if (thread.lastVisitedAt === unreadVisitedAt) return thread;
    return { ...thread, lastVisitedAt: unreadVisitedAt };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function toggleProject(state: AppState, projectId: Project["id"]): AppState {
  return {
    ...state,
    projects: state.projects.map((p) =>
      p.id === projectId ? { ...p, expanded: !p.expanded } : p,
    ),
  };
}

export function setProjectExpanded(
  state: AppState,
  projectId: Project["id"],
  expanded: boolean,
): AppState {
  let changed = false;
  const projects = state.projects.map((p) => {
    if (p.id !== projectId || p.expanded === expanded) return p;
    changed = true;
    return { ...p, expanded };
  });
  return changed ? { ...state, projects } : state;
}

export function moveProject(
  state: AppState,
  projectId: Project["id"],
  targetProjectId: Project["id"],
  position: "before" | "after",
): AppState {
  if (projectId === targetProjectId) return state;

  const currentIndex = state.projects.findIndex((project) => project.id === projectId);
  const targetIndex = state.projects.findIndex((project) => project.id === targetProjectId);
  if (currentIndex < 0 || targetIndex < 0) return state;

  const projects = [...state.projects];
  const [project] = projects.splice(currentIndex, 1);
  if (!project) return state;

  const adjustedTargetIndex = projects.findIndex((entry) => entry.id === targetProjectId);
  if (adjustedTargetIndex < 0) return state;

  const insertionIndex = position === "before" ? adjustedTargetIndex : adjustedTargetIndex + 1;
  projects.splice(insertionIndex, 0, project);

  const orderChanged = projects.some((entry, index) => entry !== state.projects[index]);
  if (!orderChanged) return state;

  return {
    ...state,
    projects,
    projectOrder: projects.map((entry) => entry.id),
  };
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function setRuntimeMode(state: AppState, mode: RuntimeMode): AppState {
  if (state.runtimeMode === mode) return state;
  return { ...state, runtimeMode: mode };
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId) => void;
  toggleProject: (projectId: Project["id"]) => void;
  moveProject: (
    projectId: Project["id"],
    targetProjectId: Project["id"],
    position: "before" | "after",
  ) => void;
  setProjectExpanded: (projectId: Project["id"], expanded: boolean) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (
    threadId: ThreadId,
    branch: string | null,
    worktreePath: string | null,
  ) => void;
  setRuntimeMode: (mode: RuntimeMode) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...readPersistedState(),
  syncServerReadModel: (readModel) =>
    set((state) => syncServerReadModel(state, readModel)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId) =>
    set((state) => markThreadUnread(state, threadId)),
  toggleProject: (projectId) =>
    set((state) => toggleProject(state, projectId)),
  moveProject: (projectId, targetProjectId, position) =>
    set((state) => moveProject(state, projectId, targetProjectId, position)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  setError: (threadId, error) =>
    set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
  setRuntimeMode: (mode) =>
    set((state) => setRuntimeMode(state, mode)),
}));

// Persist on every state change (runtimeMode + expanded projects + project order)
useStore.subscribe((state) => persistState(state));

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    persistState(useStore.getState());
  }, []);
  return createElement(Fragment, null, children);
}
