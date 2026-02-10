import type {
  NativeApi,
  ProviderCoreEvent,
  ProviderKind,
  ProviderSession,
} from "@t3tools/contracts";
import type { ChatMessage, SessionPhase, ThreadEvent } from "./types";
import { createWsNativeApi } from "./wsNativeApi";

export const PROVIDER_OPTIONS: Array<{
  value: ProviderKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeCode", label: "Claude Code (soon)", available: false },
];

let cachedApi: NativeApi | undefined;

export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  // Prefer Electron preload bridge if available
  if (window.nativeApi) {
    cachedApi = window.nativeApi;
    return cachedApi;
  }

  // Fall back to WebSocket transport
  cachedApi = createWsNativeApi();
  return cachedApi;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function formatTimestamp(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(isoDate));
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;

  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }

  return formatDuration(endedAt - startedAt);
}

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  tone: "thinking" | "tool" | "info" | "error";
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

function normalizeDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function eventTurnId(event: ProviderCoreEvent): string | undefined {
  switch (event.type) {
    case "turn.started":
    case "turn.completed":
    case "message.delta":
    case "message.completed":
    case "approval.requested":
    case "activity":
    case "error":
      return event.turnId;
    default:
      return undefined;
  }
}

function activityTone(event: Extract<ProviderCoreEvent, { type: "activity" }>): WorkLogEntry["tone"] {
  if (["failed", "denied", "timed_out"].includes(event.status)) {
    return "error";
  }

  if (event.activityKind === "plan") {
    return "thinking";
  }

  if (event.activityKind === "tool") {
    return "tool";
  }

  return "info";
}

function toWorkLogEntry(eventRecord: ThreadEvent): WorkLogEntry | null {
  const event = eventRecord.event;

  if (event.type === "activity") {
    const detail = normalizeDetail(event.detail);
    if (event.label === "Tool call" && !detail) {
      return null;
    }

    return {
      id: `activity:${event.activityId}`,
      createdAt: event.startedAt ?? event.completedAt ?? eventRecord.at,
      label: event.label,
      ...(detail ? { detail } : {}),
      tone: activityTone(event),
    };
  }

  if (event.type === "approval.requested") {
    const detail = normalizeDetail(event.detail);
    const label =
      event.approvalKind === "command"
        ? "Command approval requested"
        : event.approvalKind === "file_change"
          ? "File-change approval requested"
          : "Tool requested user input";

    return {
      id: `approval:${event.approvalId}`,
      createdAt: event.requestedAt,
      label,
      ...(detail ? { detail } : {}),
      tone: "tool",
    };
  }

  if (event.type === "turn.completed" && event.outcome === "failed") {
    return {
      id: `turn-failed:${event.turnId}`,
      createdAt: event.completedAt,
      label: "Turn failed",
      ...(event.error ? { detail: event.error } : {}),
      tone: "error",
    };
  }

  if (event.type === "error") {
    const detail = normalizeDetail(event.message);
    return {
      id: `error:${event.code}:${eventRecord.seq}`,
      createdAt: eventRecord.at,
      label: "Runtime error",
      ...(detail ? { detail } : {}),
      tone: "error",
    };
  }

  return null;
}

export function deriveWorkLogEntries(
  events: ThreadEvent[],
  turnId: string | undefined,
): WorkLogEntry[] {
  const ordered = [...events].toReversed();
  const completedActivityIds = new Set<string>();

  for (const eventRecord of ordered) {
    const event = eventRecord.event;
    if (event.type !== "activity") continue;
    if (turnId && event.turnId && event.turnId !== turnId) continue;
    if (["success", "failed", "denied", "timed_out"].includes(event.status)) {
      completedActivityIds.add(event.activityId);
    }
  }

  const entries: WorkLogEntry[] = [];
  for (const eventRecord of ordered) {
    const event = eventRecord.event;

    if (turnId) {
      const scopedTurnId = eventTurnId(event);
      if (scopedTurnId && scopedTurnId !== turnId) {
        continue;
      }
    }

    if (
      event.type === "activity" &&
      event.status === "created" &&
      completedActivityIds.has(event.activityId)
    ) {
      continue;
    }

    const entry = toWorkLogEntry(eventRecord);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

function toTimestamp(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  let messageIndex = 0;
  let workIndex = 0;

  while (messageIndex < messages.length || workIndex < workEntries.length) {
    const message = messages[messageIndex];
    const workEntry = workEntries[workIndex];

    if (!message && workEntry) {
      timeline.push({
        id: `work:${workEntry.id}`,
        kind: "work",
        createdAt: workEntry.createdAt,
        entry: workEntry,
      });
      workIndex += 1;
      continue;
    }

    if (!workEntry && message) {
      timeline.push({
        id: `message:${message.id}`,
        kind: "message",
        createdAt: message.createdAt,
        message,
      });
      messageIndex += 1;
      continue;
    }

    if (!message || !workEntry) {
      break;
    }

    const messageAt = toTimestamp(message.createdAt);
    const workAt = toTimestamp(workEntry.createdAt);

    if (workAt <= messageAt) {
      timeline.push({
        id: `work:${workEntry.id}`,
        kind: "work",
        createdAt: workEntry.createdAt,
        entry: workEntry,
      });
      workIndex += 1;
      continue;
    }

    timeline.push({
      id: `message:${message.id}`,
      kind: "message",
      createdAt: message.createdAt,
      message,
    });
    messageIndex += 1;
  }

  return timeline;
}

export function derivePhase(session: ProviderSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}

export function evolveSession(
  previous: ProviderSession,
  event: ProviderCoreEvent,
  frameAt: string,
): ProviderSession {
  if (event.type === "session.updated") {
    return event.session;
  }

  if (event.type === "turn.started") {
    return {
      ...previous,
      status: "running",
      threadId: event.threadId,
      activeTurnId: event.turnId,
      ...(event.model ? { model: event.model } : {}),
      updatedAt: event.startedAt,
    };
  }

  if (event.type === "turn.completed") {
    return {
      ...previous,
      status: event.outcome === "failed" ? "error" : "ready",
      threadId: event.threadId,
      activeTurnId: undefined,
      ...(event.error ? { lastError: event.error } : {}),
      updatedAt: event.completedAt,
    };
  }

  if (event.type === "error") {
    return {
      ...previous,
      ...(event.retryable ? {} : { status: "error" }),
      lastError: event.message,
      updatedAt: frameAt,
    };
  }

  return {
    ...previous,
    updatedAt: frameAt,
  };
}

export function applyEventToMessages(
  previous: ChatMessage[],
  event: ProviderCoreEvent,
  frameAt: string,
  activeAssistantMessageRef: { current: string | null },
): ChatMessage[] {
  if (event.type === "message.delta") {
    const messageId = event.messageId;
    const delta = event.delta;
    if (!delta) return previous;

    const existingIndex = previous.findIndex((entry) => entry.id === messageId);
    if (existingIndex === -1) {
      activeAssistantMessageRef.current = messageId;
      return [
        ...previous,
        {
          id: messageId,
          role: "assistant",
          text: delta,
          createdAt: frameAt,
          streaming: true,
        },
      ];
    }

    const updated = [...previous];
    const existing = updated[existingIndex];
    if (!existing) return previous;

    updated[existingIndex] = {
      ...existing,
      text: `${existing.text}${delta}`,
      streaming: true,
    };
    return updated;
  }

  if (event.type === "message.completed") {
    const messageId = event.messageId;
    const existingIndex = previous.findIndex((entry) => entry.id === messageId);

    if (existingIndex === -1) {
      return [
        ...previous,
        {
          id: messageId,
          role: "assistant",
          text: event.text,
          createdAt: frameAt,
          streaming: false,
        },
      ];
    }

    const updated = [...previous];
    const existing = updated[existingIndex];
    if (!existing) return previous;

    updated[existingIndex] = {
      ...existing,
      text: event.text || existing.text,
      streaming: false,
    };

    if (activeAssistantMessageRef.current === messageId) {
      activeAssistantMessageRef.current = null;
    }

    return updated;
  }

  if (event.type === "turn.completed") {
    return previous.map((entry) => ({ ...entry, streaming: false }));
  }

  return previous;
}
