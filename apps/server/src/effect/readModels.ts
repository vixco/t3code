import type {
  CoreGitStatusSnapshot,
  CoreProjectView,
  CoreReadModelSnapshot,
  CoreThreadMessageView,
  CoreThreadView,
  CoreViewDelta,
} from "@t3tools/contracts";

import type { PersistedEvent } from "./eventStore";

export interface ReadModelMaps {
  projects: Map<string, CoreProjectView>;
  threads: Map<string, CoreThreadView>;
  git: Map<string, CoreGitStatusSnapshot>;
  sequence: number;
}

export function emptyReadModelMaps(): ReadModelMaps {
  return {
    projects: new Map(),
    threads: new Map(),
    git: new Map(),
    sequence: 0,
  };
}

function parsePayload(event: PersistedEvent): unknown {
  return JSON.parse(event.payloadJson) as unknown;
}

function cloneMaps(state: ReadModelMaps): ReadModelMaps {
  return {
    projects: new Map(state.projects),
    threads: new Map(state.threads),
    git: new Map(state.git),
    sequence: state.sequence,
  };
}

function buildThreadBase(payload: {
  id: string;
  projectId: string;
  title: string;
  model: string;
  createdAt?: string;
}): CoreThreadView {
  const createdAt = payload.createdAt ?? new Date().toISOString();
  return {
    id: payload.id,
    projectId: payload.projectId,
    title: payload.title,
    model: payload.model,
    createdAt,
    updatedAt: createdAt,
    sessionId: null,
    messages: [],
    branch: null,
    worktreePath: null,
  };
}

function appendMessage(
  thread: CoreThreadView,
  message: { id: string; role: "user" | "assistant"; text: string; createdAt: string },
  updatedAt: string,
): CoreThreadView {
  const nextMessage: CoreThreadMessageView = {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    streaming: false,
  };
  return {
    ...thread,
    updatedAt,
    messages: [...thread.messages, nextMessage],
  };
}

export function applyEventToReadModels(state: ReadModelMaps, event: PersistedEvent): ReadModelMaps {
  const next = cloneMaps(state);
  next.sequence = event.sequence;

  switch (event.eventType) {
    case "ProjectCreated": {
      const payload = parsePayload(event) as CoreProjectView;
      next.projects.set(payload.id, payload);
      return next;
    }
    case "ProjectDeleted": {
      const payload = parsePayload(event) as { id: string };
      next.projects.delete(payload.id);
      return next;
    }
    case "ThreadCreated": {
      const payload = parsePayload(event) as {
        id: string;
        projectId: string;
        title: string;
        model: string;
        createdAt?: string;
      };
      next.threads.set(payload.id, buildThreadBase(payload));
      return next;
    }
    case "UserMessageAppended": {
      const payload = parsePayload(event) as {
        threadId: string;
        messageId: string;
        text: string;
        createdAt: string;
      };
      const existing = next.threads.get(payload.threadId);
      if (!existing) return next;
      next.threads.set(
        payload.threadId,
        appendMessage(
          existing,
          {
            id: payload.messageId,
            role: "user",
            text: payload.text,
            createdAt: payload.createdAt,
          },
          event.occurredAt,
        ),
      );
      return next;
    }
    case "AssistantMessageAppended": {
      const payload = parsePayload(event) as {
        threadId: string;
        messageId: string;
        text: string;
        createdAt: string;
      };
      const existing = next.threads.get(payload.threadId);
      if (!existing) return next;
      next.threads.set(
        payload.threadId,
        appendMessage(
          existing,
          {
            id: payload.messageId,
            role: "assistant",
            text: payload.text,
            createdAt: payload.createdAt,
          },
          event.occurredAt,
        ),
      );
      return next;
    }
    case "ThreadBranchSet": {
      const payload = parsePayload(event) as {
        threadId: string;
        branch: string | null;
        worktreePath: string | null;
      };
      const existing = next.threads.get(payload.threadId);
      if (!existing) return next;
      next.threads.set(payload.threadId, {
        ...existing,
        updatedAt: event.occurredAt,
        branch: payload.branch,
        worktreePath: payload.worktreePath,
      });
      return next;
    }
    case "GitStateObserved": {
      const payload = parsePayload(event) as CoreGitStatusSnapshot;
      next.git.set(payload.cwd, payload);
      return next;
    }
    default:
      return next;
  }
}

export function rebuildReadModels(events: readonly PersistedEvent[]): ReadModelMaps {
  let state = emptyReadModelMaps();
  for (const event of events) {
    state = applyEventToReadModels(state, event);
  }
  return state;
}

export function toReadModelSnapshot(state: ReadModelMaps): CoreReadModelSnapshot {
  return {
    sequence: state.sequence,
    generatedAt: new Date().toISOString(),
    projects: [...state.projects.values()],
    threads: [...state.threads.values()].toSorted(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    ),
    git: [...state.git.values()],
  };
}

export function deltaFromEvent(event: PersistedEvent, state: ReadModelMaps): CoreViewDelta {
  switch (event.eventType) {
    case "ProjectCreated":
      return {
        kind: "projectUpsert",
        sequence: event.sequence,
        project: state.projects.get(event.streamId) ?? (JSON.parse(event.payloadJson) as CoreProjectView),
      };
    case "ProjectDeleted":
      return {
        kind: "projectDelete",
        sequence: event.sequence,
        projectId: (JSON.parse(event.payloadJson) as { id: string }).id,
      };
    case "ThreadCreated":
    case "UserMessageAppended":
    case "AssistantMessageAppended":
    case "ThreadBranchSet": {
      const payload = JSON.parse(event.payloadJson) as { id?: string; threadId?: string };
      const threadId = payload.threadId ?? payload.id ?? event.streamId;
      return {
        kind: "threadUpsert",
        sequence: event.sequence,
        thread:
          state.threads.get(threadId) ??
          ({
            id: threadId,
            projectId: "",
            title: "Unknown thread",
            model: "gpt-5",
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
            sessionId: null,
            messages: [],
            branch: null,
            worktreePath: null,
          } satisfies CoreThreadView),
      };
    }
    case "GitStateObserved":
      return {
        kind: "gitStatusUpsert",
        sequence: event.sequence,
        git:
          state.git.get((JSON.parse(event.payloadJson) as { cwd: string }).cwd) ??
          (JSON.parse(event.payloadJson) as CoreGitStatusSnapshot),
      };
    default:
      return {
        kind: "snapshot",
        sequence: event.sequence,
        snapshot: toReadModelSnapshot(state),
      };
  }
}
