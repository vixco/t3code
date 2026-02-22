import {
  type Dispatch,
  type ReactNode,
  createContext,
  createElement,
  useContext,
  useReducer,
} from "react";

import {
  type CoreReadModelSnapshot,
  type CoreThreadMessageView,
  type CoreViewDelta,
  type ProviderSession,
  normalizeProjectScripts,
} from "@t3tools/contracts";
import { resolveModelSlug } from "./model-logic";
import {
  type ChatAttachment,
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  DEFAULT_RUNTIME_MODE,
  MAX_THREAD_TERMINAL_COUNT,
  type ProjectScript,
  type Project,
  type RuntimeMode,
  type Thread,
  type ThreadTerminalGroup,
} from "./types";

function normalizeScriptIcon(icon: string | null | undefined): ProjectScript["icon"] {
  switch (icon) {
    case "play":
    case "test":
    case "lint":
    case "configure":
    case "build":
    case "debug":
      return icon;
    default:
      return "play";
  }
}

// ── Actions ──────────────────────────────────────────────────────────

type Action =
  | { type: "ADD_PROJECT"; project: Project }
  | { type: "SET_PROJECT_SCRIPTS"; projectId: string; scripts: ProjectScript[] }
  | { type: "SYNC_PROJECTS"; projects: Project[] }
  | { type: "SET_THREADS_HYDRATED"; hydrated: boolean }
  | { type: "APPLY_CORE_SNAPSHOT"; snapshot: CoreReadModelSnapshot }
  | { type: "APPLY_CORE_DELTA"; delta: CoreViewDelta }
  | { type: "TOGGLE_PROJECT"; projectId: string }
  | { type: "DELETE_PROJECT"; projectId: string }
  | { type: "ADD_THREAD"; thread: Thread }
  | { type: "TOGGLE_THREAD_TERMINAL"; threadId: string }
  | { type: "SET_THREAD_TERMINAL_OPEN"; threadId: string; open: boolean }
  | { type: "SET_THREAD_TERMINAL_HEIGHT"; threadId: string; height: number }
  | { type: "SPLIT_THREAD_TERMINAL"; threadId: string; terminalId: string }
  | { type: "NEW_THREAD_TERMINAL"; threadId: string; terminalId: string }
  | { type: "SET_THREAD_ACTIVE_TERMINAL"; threadId: string; terminalId: string }
  | { type: "CLOSE_THREAD_TERMINAL"; threadId: string; terminalId: string }
  | { type: "UPDATE_SESSION"; threadId: string; session: ProviderSession }
  | {
      type: "PUSH_USER_MESSAGE";
      threadId: string;
      id: string;
      text: string;
      attachments?: ChatAttachment[];
    }
  | { type: "SET_ERROR"; threadId: string; error: string | null }
  | { type: "SET_THREAD_TITLE"; threadId: string; title: string }
  | { type: "SET_THREAD_MODEL"; threadId: string; model: string }
  | {
      type: "REVERT_TO_CHECKPOINT";
      threadId: string;
      sessionId: string;
      threadRuntimeId: string;
      turnCount: number;
      messageCount: number;
    }
  | {
      type: "SET_THREAD_TURN_CHECKPOINT_COUNTS";
      threadId: string;
      checkpointTurnCountByTurnId: Record<string, number>;
    }
  | {
      type: "SET_THREAD_BRANCH";
      threadId: string;
      branch: string | null;
      worktreePath: string | null;
    }
  | { type: "MARK_THREAD_VISITED"; threadId: string; visitedAt?: string }
  | { type: "SET_RUNTIME_MODE"; mode: RuntimeMode }
  | { type: "DELETE_THREAD"; threadId: string };

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  threadsHydrated: boolean;
  runtimeMode: RuntimeMode;
}

const initialState: AppState = {
  projects: [],
  threads: [],
  threadsHydrated: false,
  runtimeMode: DEFAULT_RUNTIME_MODE,
};

// ── Helpers ──────────────────────────────────────────────────────────

function readPersistedState(): AppState {
  return initialState;
}

function mapCoreMessageToChatMessage(message: CoreThreadMessageView): Thread["messages"][number] {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    streaming: message.streaming,
  };
}

function mapCoreScriptsToProjectScripts(
  scripts: CoreReadModelSnapshot["projects"][number]["scripts"],
): ProjectScript[] {
  return scripts.map((script) => {
    const icon = normalizeScriptIcon(script.icon ?? undefined);
    return {
      id: script.id,
      name: script.name,
      command: script.command,
      icon,
      runOnWorktreeCreate: script.runOnWorktreeCreate ?? false,
    };
  });
}

function mapSnapshotToState(snapshot: CoreReadModelSnapshot, previous: AppState): AppState {
  const projects: Project[] = snapshot.projects.map((project) => ({
    id: project.id,
    name: project.name,
    cwd: project.cwd,
    model: project.model,
    expanded: project.expanded,
    scripts: mapCoreScriptsToProjectScripts(project.scripts),
  }));

  const threads: Thread[] = snapshot.threads.map((thread) => {
    const existing = previous.threads.find((entry) => entry.id === thread.id);
    const next: Thread = {
      id: thread.id,
      codexThreadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      model: thread.model,
      terminalOpen: existing?.terminalOpen ?? false,
      terminalHeight: existing?.terminalHeight ?? DEFAULT_THREAD_TERMINAL_HEIGHT,
      terminalIds: existing?.terminalIds ?? [DEFAULT_THREAD_TERMINAL_ID],
      runningTerminalIds: existing?.runningTerminalIds ?? [],
      activeTerminalId: existing?.activeTerminalId ?? DEFAULT_THREAD_TERMINAL_ID,
      terminalGroups: existing?.terminalGroups ?? [
        {
          id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
          terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
        },
      ],
      activeTerminalGroupId: existing?.activeTerminalGroupId ?? `group-${DEFAULT_THREAD_TERMINAL_ID}`,
      session: existing?.session ?? null,
      messages: thread.messages.map(mapCoreMessageToChatMessage),
      events: existing?.events ?? [],
      error: existing?.error ?? null,
      createdAt: thread.createdAt,
      latestTurnId: existing?.latestTurnId,
      latestTurnStartedAt: existing?.latestTurnStartedAt,
      latestTurnCompletedAt: existing?.latestTurnCompletedAt,
      latestTurnDurationMs: existing?.latestTurnDurationMs,
      lastVisitedAt: existing?.lastVisitedAt,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      turnDiffSummaries: existing?.turnDiffSummaries ?? [],
    };
    return normalizeThreadTerminals(next);
  });

  return {
    ...previous,
    projects,
    threads,
    threadsHydrated: true,
  };
}

function updateThread(
  threads: Thread[],
  threadId: string,
  updater: (t: Thread) => Thread,
): Thread[] {
  return threads.map((t) => (t.id === threadId ? updater(t) : t));
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const ids = terminalIds.map((id) => id.trim()).filter((id) => id.length > 0);
  const unique = [...new Set(ids)].slice(0, MAX_THREAD_TERMINAL_COUNT);
  if (unique.length > 0) {
    return unique;
  }
  return [DEFAULT_THREAD_TERMINAL_ID];
}

function normalizeRunningTerminalIds(
  runningTerminalIds: string[],
  terminalIds: string[],
): string[] {
  if (runningTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIdSet.has(id));
}


function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(groupId: string, usedGroupIds: Set<string>): string {
  if (!usedGroupIds.has(groupId)) {
    usedGroupIds.add(groupId);
    return groupId;
  }
  let suffix = 2;
  while (usedGroupIds.has(`${groupId}-${suffix}`)) {
    suffix += 1;
  }
  const uniqueGroupId = `${groupId}-${suffix}`;
  usedGroupIds.add(uniqueGroupId);
  return uniqueGroupId;
}

function normalizeTerminalGroups(thread: Thread, terminalIds: string[]): ThreadTerminalGroup[] {
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const usedGroupIds = new Set<string>();
  const groups: ThreadTerminalGroup[] = [];

  for (const group of thread.terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
    groups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    groups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (groups.length > 0) {
    return groups;
  }

  return [
    {
      id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    },
  ];
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeThreadTerminals(thread: Thread): Thread {
  const terminalIds = normalizeTerminalIds(thread.terminalIds);
  const activeTerminalId = terminalIds.includes(thread.activeTerminalId)
    ? thread.activeTerminalId
    : (terminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const terminalGroups = normalizeTerminalGroups(thread, terminalIds);
  const activeGroupIndexFromId = terminalGroups.findIndex(
    (group) => group.id === thread.activeTerminalGroupId,
  );
  const activeGroupIndexFromTerminal = findGroupIndexByTerminalId(terminalGroups, activeTerminalId);
  const activeGroupIndex =
    activeGroupIndexFromId >= 0
      ? activeGroupIndexFromId
      : activeGroupIndexFromTerminal >= 0
        ? activeGroupIndexFromTerminal
        : 0;
  const activeTerminalGroupId =
    terminalGroups[activeGroupIndex]?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(activeTerminalId);

  return {
    ...thread,
    terminalIds,
    runningTerminalIds: normalizeRunningTerminalIds(thread.runningTerminalIds, terminalIds),
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId,
  };
}

function closeThreadTerminal(thread: Thread, terminalId: string): Thread {
  if (!thread.terminalIds.includes(terminalId)) {
    return thread;
  }

  const remainingTerminalIds = thread.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    const nextTerminalGroupId = fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID);
    return normalizeThreadTerminals({
      ...thread,
      terminalOpen: false,
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      runningTerminalIds: [],
      activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
      terminalGroups: [
        {
          id: nextTerminalGroupId,
          terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
        },
      ],
      activeTerminalGroupId: nextTerminalGroupId,
    });
  }

  const closedTerminalIndex = thread.terminalIds.indexOf(terminalId);
  const closedTerminalGroup = thread.terminalGroups.find((group) =>
    group.terminalIds.includes(terminalId),
  );
  const closedTerminalGroupIndex = closedTerminalGroup
    ? closedTerminalGroup.terminalIds.indexOf(terminalId)
    : -1;
  const remainingTerminalsInClosedGroup = (closedTerminalGroup?.terminalIds ?? []).filter(
    (id) => id !== terminalId,
  );
  const nextActiveTerminalId =
    thread.activeTerminalId === terminalId
      ? (remainingTerminalsInClosedGroup[
          Math.min(closedTerminalGroupIndex, remainingTerminalsInClosedGroup.length - 1)
        ] ??
        remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        DEFAULT_THREAD_TERMINAL_ID)
      : thread.activeTerminalId;
  const nextTerminalGroups = thread.terminalGroups
    .map((group) => ({
      ...group,
      terminalIds: group.terminalIds.filter((id) => id !== terminalId),
    }))
    .filter((group) => group.terminalIds.length > 0);

  return normalizeThreadTerminals({
    ...thread,
    terminalIds: remainingTerminalIds,
    runningTerminalIds: thread.runningTerminalIds.filter((id) => id !== terminalId),
    activeTerminalId: nextActiveTerminalId,
    terminalGroups: nextTerminalGroups,
  });
}

// ── Reducer ──────────────────────────────────────────────────────────

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "ADD_PROJECT":
      if (state.projects.some((project) => project.cwd === action.project.cwd)) {
        return state;
      }
      return {
        ...state,
        projects: [
          ...state.projects,
          {
            ...action.project,
            model: resolveModelSlug(action.project.model),
            scripts: normalizeProjectScripts(action.project.scripts),
          },
        ],
      };

    case "SET_PROJECT_SCRIPTS":
      return {
        ...state,
        projects: state.projects.map((project) =>
          project.id === action.projectId
            ? { ...project, scripts: normalizeProjectScripts(action.scripts) }
            : project,
        ),
      };

    case "SET_THREADS_HYDRATED":
      if (state.threadsHydrated === action.hydrated) {
        return state;
      }
      return {
        ...state,
        threadsHydrated: action.hydrated,
      };

    case "APPLY_CORE_SNAPSHOT":
      return mapSnapshotToState(action.snapshot, state);

    case "APPLY_CORE_DELTA": {
      const delta = action.delta;
      switch (delta.kind) {
        case "snapshot":
          return mapSnapshotToState(delta.snapshot, state);
        case "projectUpsert": {
          const project: Project = {
            id: delta.project.id,
            name: delta.project.name,
            cwd: delta.project.cwd,
            model: delta.project.model,
            expanded: delta.project.expanded,
            scripts: mapCoreScriptsToProjectScripts(delta.project.scripts),
          };
          const existing = state.projects.find((item) => item.id === project.id);
          return {
            ...state,
            projects: existing
              ? state.projects.map((item) => (item.id === project.id ? project : item))
              : [...state.projects, project],
          };
        }
        case "projectDelete":
          return {
            ...state,
            projects: state.projects.filter((project) => project.id !== delta.projectId),
            threads: state.threads.filter((thread) => thread.projectId !== delta.projectId),
          };
        case "threadDelete":
          return {
            ...state,
            threads: state.threads.filter((thread) => thread.id !== delta.threadId),
          };
        case "threadUpsert": {
          const snapshot: CoreReadModelSnapshot = {
            sequence: delta.sequence,
            generatedAt: new Date().toISOString(),
            projects: state.projects.map((project) => ({
              id: project.id,
              name: project.name,
              cwd: project.cwd,
              model: project.model,
              expanded: project.expanded,
              scripts: project.scripts.map((script) => ({
                id: script.id,
                name: script.name,
                command: script.command,
                icon: script.icon,
                runOnWorktreeCreate: script.runOnWorktreeCreate,
              })),
            })),
            threads: [
              ...state.threads
                .filter((thread) => thread.id !== delta.thread.id)
                .map((thread) => ({
                  id: thread.id,
                  projectId: thread.projectId,
                  title: thread.title,
                  model: thread.model,
                  createdAt: thread.createdAt,
                  updatedAt: thread.latestTurnCompletedAt ?? thread.createdAt,
                  sessionId: thread.session?.sessionId ?? null,
                  messages: thread.messages.map((message) => ({
                    id: message.id,
                    role: message.role,
                    text: message.text,
                    createdAt: message.createdAt,
                    streaming: message.streaming,
                  })),
                  branch: thread.branch,
                  worktreePath: thread.worktreePath,
                })),
              delta.thread,
            ],
            git: [],
          };
          return mapSnapshotToState(snapshot, state);
        }
        case "gitStatusUpsert":
          return state;
      }
    }

    case "SYNC_PROJECTS": {
      const previousByCwd = new Map(
        state.projects.map((project) => [project.cwd, project] as const),
      );
      const nextProjects = action.projects.map((project) => {
        const previous = previousByCwd.get(project.cwd);
        const scripts = normalizeProjectScripts(project.scripts);
        return {
          ...project,
          model: resolveModelSlug(previous?.model ?? project.model),
          expanded: previous?.expanded ?? project.expanded,
          scripts,
        };
      });
      const previousProjectById = new Map(
        state.projects.map((project) => [project.id, project] as const),
      );
      const nextProjectIdByCwd = new Map(
        nextProjects.map((project) => [project.cwd, project.id] as const),
      );
      const nextThreads = state.threads
        .map((thread) => {
          const previousProject = previousProjectById.get(thread.projectId);
          if (!previousProject) return null;
          const mappedProjectId = nextProjectIdByCwd.get(previousProject.cwd);
          if (!mappedProjectId) return null;
          return normalizeThreadTerminals({
            ...thread,
            projectId: mappedProjectId,
          });
        })
        .filter((thread): thread is Thread => thread !== null);

      return {
        ...state,
        projects: nextProjects,
        threads: nextThreads,
      };
    }

    case "TOGGLE_PROJECT":
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.projectId ? { ...p, expanded: !p.expanded } : p,
        ),
      };

    case "DELETE_PROJECT": {
      const projects = state.projects.filter((project) => project.id !== action.projectId);
      if (projects.length === state.projects.length) {
        return state;
      }

      const threads = state.threads.filter((thread) => thread.projectId !== action.projectId);

      return {
        ...state,
        projects,
        threads,
      };
    }

    case "ADD_THREAD": {
      const nextThread = normalizeThreadTerminals({
        ...action.thread,
        model: resolveModelSlug(action.thread.model),
        lastVisitedAt: action.thread.lastVisitedAt ?? action.thread.createdAt,
        turnDiffSummaries: action.thread.turnDiffSummaries ?? [],
      });
      return {
        ...state,
        threads: [...state.threads, nextThread],
      };
    }

    case "TOGGLE_THREAD_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          terminalOpen: !t.terminalOpen,
        })),
      };

    case "SET_THREAD_TERMINAL_OPEN":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          terminalOpen: action.open,
        })),
      };

    case "SET_THREAD_TERMINAL_HEIGHT":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          terminalHeight: action.height,
        })),
      };

    case "SPLIT_THREAD_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) => {
          const normalizedThread = normalizeThreadTerminals(thread);
          const isNewTerminal = !normalizedThread.terminalIds.includes(action.terminalId);
          if (
            isNewTerminal &&
            normalizedThread.terminalIds.length >= MAX_THREAD_TERMINAL_COUNT
          ) {
            return normalizedThread;
          }
          const terminalIds = normalizedThread.terminalIds.includes(action.terminalId)
            ? normalizedThread.terminalIds
            : [...normalizedThread.terminalIds, action.terminalId];
          const terminalGroups = normalizedThread.terminalGroups.map((group) => ({
            ...group,
            terminalIds: [...group.terminalIds],
          }));
          let activeGroupIndex = terminalGroups.findIndex(
            (group) => group.id === normalizedThread.activeTerminalGroupId,
          );
          if (activeGroupIndex < 0) {
            activeGroupIndex = findGroupIndexByTerminalId(
              terminalGroups,
              normalizedThread.activeTerminalId,
            );
          }
          if (activeGroupIndex < 0) {
            terminalGroups.push({
              id: fallbackGroupId(normalizedThread.activeTerminalId),
              terminalIds: [normalizedThread.activeTerminalId],
            });
            activeGroupIndex = terminalGroups.length - 1;
          }

          const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, action.terminalId);
          if (existingGroupIndex >= 0) {
            terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
              existingGroupIndex
            ]!.terminalIds.filter((id) => id !== action.terminalId);
            if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
              terminalGroups.splice(existingGroupIndex, 1);
              if (existingGroupIndex < activeGroupIndex) {
                activeGroupIndex -= 1;
              }
            }
          }

          const destinationGroup = terminalGroups[activeGroupIndex];
          if (!destinationGroup) {
            return normalizedThread;
          }
          if (!destinationGroup.terminalIds.includes(action.terminalId)) {
            const anchorIndex = destinationGroup.terminalIds.indexOf(
              normalizedThread.activeTerminalId,
            );
            if (anchorIndex >= 0) {
              destinationGroup.terminalIds.splice(anchorIndex + 1, 0, action.terminalId);
            } else {
              destinationGroup.terminalIds.push(action.terminalId);
            }
          }
          return normalizeThreadTerminals({
            ...normalizedThread,
            terminalIds,
            activeTerminalId: action.terminalId,
            activeTerminalGroupId: destinationGroup.id,
            terminalGroups,
          });
        }),
      };

    case "NEW_THREAD_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) => {
          const normalizedThread = normalizeThreadTerminals(thread);
          const isNewTerminal = !normalizedThread.terminalIds.includes(action.terminalId);
          if (
            isNewTerminal &&
            normalizedThread.terminalIds.length >= MAX_THREAD_TERMINAL_COUNT
          ) {
            return normalizedThread;
          }
          const terminalIds = normalizedThread.terminalIds.includes(action.terminalId)
            ? normalizedThread.terminalIds
            : [...normalizedThread.terminalIds, action.terminalId];
          const terminalGroups = normalizedThread.terminalGroups
            .map((group) => ({
              ...group,
              terminalIds: group.terminalIds.filter((id) => id !== action.terminalId),
            }))
            .filter((group) => group.terminalIds.length > 0);
          const nextGroupId = fallbackGroupId(action.terminalId);
          terminalGroups.push({ id: nextGroupId, terminalIds: [action.terminalId] });

          return normalizeThreadTerminals({
            ...normalizedThread,
            terminalIds,
            activeTerminalId: action.terminalId,
            activeTerminalGroupId: nextGroupId,
            terminalGroups,
          });
        }),
      };

    case "SET_THREAD_ACTIVE_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) => {
          const normalizedThread = normalizeThreadTerminals(thread);
          if (!normalizedThread.terminalIds.includes(action.terminalId)) {
            return thread;
          }
          const nextActiveGroupIndex = findGroupIndexByTerminalId(
            normalizedThread.terminalGroups,
            action.terminalId,
          );
          const activeTerminalGroupId =
            nextActiveGroupIndex >= 0
              ? (normalizedThread.terminalGroups[nextActiveGroupIndex]?.id ??
                normalizedThread.activeTerminalGroupId)
              : normalizedThread.activeTerminalGroupId;
          return normalizeThreadTerminals({
            ...normalizedThread,
            activeTerminalId: action.terminalId,
            activeTerminalGroupId,
          });
        }),
      };

    case "CLOSE_THREAD_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) =>
          closeThreadTerminal(thread, action.terminalId),
        ),
      };

    case "UPDATE_SESSION":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          session: action.session,
          codexThreadId: action.session.threadId ?? t.codexThreadId,
          events: [],
          error: null,
          latestTurnId: undefined,
          latestTurnStartedAt: undefined,
          latestTurnCompletedAt: undefined,
          latestTurnDurationMs: undefined,
        })),
      };

    case "PUSH_USER_MESSAGE":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          messages: [
            ...t.messages,
            {
              id: action.id,
              role: "user" as const,
              text: action.text,
              ...(action.attachments && action.attachments.length > 0
                ? { attachments: action.attachments }
                : {}),
              createdAt: new Date().toISOString(),
              streaming: false,
            },
          ],
        })),
      };

    case "SET_ERROR":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          error: action.error,
        })),
      };

    case "SET_THREAD_TITLE":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          title: action.title,
        })),
      };

    case "SET_THREAD_MODEL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          model: resolveModelSlug(action.model),
        })),
      };

    case "REVERT_TO_CHECKPOINT":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => {
          const nextMessageCount = Math.max(0, Math.floor(action.messageCount));
          const nextTurnCount = Math.max(0, Math.floor(action.turnCount));
          const now = new Date().toISOString();
          return {
            ...t,
            codexThreadId: action.threadRuntimeId,
            session:
              t.session?.sessionId === action.sessionId
                ? {
                    ...t.session,
                    status: "ready",
                    threadId: action.threadRuntimeId,
                    activeTurnId: undefined,
                    updatedAt: now,
                    lastError: undefined,
                  }
                : t.session,
            messages: t.messages.slice(0, nextMessageCount),
            events: [],
            turnDiffSummaries: t.turnDiffSummaries.filter(
              (summary) =>
                typeof summary.checkpointTurnCount === "number" &&
                summary.checkpointTurnCount <= nextTurnCount,
            ),
            error: null,
            latestTurnId: undefined,
            latestTurnStartedAt: undefined,
            latestTurnCompletedAt: undefined,
            latestTurnDurationMs: undefined,
            lastVisitedAt: now,
          };
        }),
      };

    case "SET_THREAD_TURN_CHECKPOINT_COUNTS":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => {
          const hasUpdates = t.turnDiffSummaries.some(
            (summary) =>
              action.checkpointTurnCountByTurnId[summary.turnId] !== undefined &&
              action.checkpointTurnCountByTurnId[summary.turnId] !== summary.checkpointTurnCount,
          );
          if (!hasUpdates) {
            return t;
          }
          return {
            ...t,
            turnDiffSummaries: t.turnDiffSummaries.map((summary) => {
              const turnCount = action.checkpointTurnCountByTurnId[summary.turnId];
              if (turnCount === undefined) {
                return summary;
              }
              return {
                ...summary,
                checkpointTurnCount: turnCount,
              };
            }),
          };
        }),
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

    case "MARK_THREAD_VISITED": {
      const visitedAt = action.visitedAt ?? new Date().toISOString();
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          lastVisitedAt: visitedAt,
        })),
      };
    }

    case "SET_RUNTIME_MODE":
      return {
        ...state,
        runtimeMode: action.mode,
      };

    case "DELETE_THREAD":
      return {
        ...state,
        threads: state.threads.filter((t) => t.id !== action.threadId),
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

  return createElement(StoreContext.Provider, { value: { state, dispatch } }, children);
}

export function useStore() {
  return useContext(StoreContext);
}
