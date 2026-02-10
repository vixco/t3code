import type {
  CanonicalApprovalState,
  CanonicalMessageState,
  CanonicalSessionState,
  CanonicalTurnState,
  ProviderCoreEvent,
  ProviderSnapshot,
  ProviderStreamEventKind,
  ProviderStreamFrame,
  ProviderStreamGapReason,
} from "@t3tools/contracts";

export const PROVIDER_STREAM_MAX_REPLAY_EVENTS = 20_000;
export const PROVIDER_STREAM_MAX_REPLAY_BYTES = 64 * 1024 * 1024;
export const PROVIDER_STREAM_MAX_REPLAY_AGE_MS = 60 * 60 * 1_000;
export const PROVIDER_STREAM_REPLAY_OPEN_LIMIT = 10_000;

interface StoredStreamEvent {
  seq: number;
  at: string;
  data: ProviderCoreEvent;
  encodedSize: number;
}

export type ReplaySelection =
  | {
      ok: true;
      currentSeq: number;
      oldestSeq: number;
      events: Array<Pick<StoredStreamEvent, "seq" | "at" | "data">>;
    }
  | {
      ok: false;
      currentSeq: number;
      oldestSeq: number;
      reason: ProviderStreamGapReason;
    };

function parseIsoToMs(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return Date.now();
  }
  return parsed;
}

function sessionEventKey(sessionId: string, id: string): string {
  return `${sessionId}:${id}`;
}

function eventSizeBytes(seq: number, at: string, data: ProviderCoreEvent): number {
  return Buffer.byteLength(JSON.stringify({ kind: "event", seq, at, data }));
}

function eventKindOf(event: ProviderCoreEvent): ProviderStreamEventKind {
  if (event.type === "session.updated") {
    return "session";
  }
  if (event.type === "turn.started" || event.type === "turn.completed") {
    return "turn";
  }
  if (event.type === "message.delta" || event.type === "message.completed") {
    return "message";
  }
  if (event.type === "approval.requested" || event.type === "approval.resolved") {
    return "approval";
  }
  if (event.type === "activity") {
    return "activity";
  }
  if (event.type === "error") {
    return "error";
  }
  return "debug.raw";
}

export function providerStreamEventKindOf(
  event: ProviderCoreEvent,
): ProviderStreamEventKind {
  return eventKindOf(event);
}

export function providerStreamEventSessionId(
  event: ProviderCoreEvent,
): string | undefined {
  if (event.type === "session.updated") {
    return event.session.sessionId;
  }

  if (event.type === "debug.raw") {
    return event.sessionId;
  }

  return event.sessionId;
}

export function filterEventExtensions(
  event: ProviderCoreEvent,
  includeExtensions: ReadonlySet<string>,
): ProviderCoreEvent {
  if (!("extensions" in event)) {
    return event;
  }

  if (!event.extensions || includeExtensions.size === 0) {
    const withoutExtensions = { ...event };
    delete withoutExtensions.extensions;
    return withoutExtensions;
  }

  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.extensions)) {
    if (includeExtensions.has(key)) {
      filtered[key] = value;
    }
  }

  if (Object.keys(filtered).length === 0) {
    const withoutExtensions = { ...event };
    delete withoutExtensions.extensions;
    return withoutExtensions;
  }

  return {
    ...event,
    extensions: filtered,
  };
}

function isFromSessionFilter(
  sessionIds: ReadonlySet<string> | undefined,
  sessionId: string,
): boolean {
  if (!sessionIds || sessionIds.size === 0) {
    return true;
  }

  return sessionIds.has(sessionId);
}

export class ProviderStreamStore {
  private nextSeq = 1;
  private replayLog: StoredStreamEvent[] = [];
  private replayBytes = 0;

  private readonly sessionsById = new Map<string, CanonicalSessionState>();
  private readonly activeTurnsByKey = new Map<string, CanonicalTurnState>();
  private readonly activeMessagesByKey = new Map<string, CanonicalMessageState>();
  private readonly pendingApprovalsByKey = new Map<string, CanonicalApprovalState>();

  appendEvent(event: ProviderCoreEvent, at = new Date().toISOString()): ProviderStreamFrame {
    const seq = this.nextSeq;
    this.nextSeq += 1;

    this.applyEvent(event, at);

    const encodedSize = eventSizeBytes(seq, at, event);
    this.replayLog.push({
      seq,
      at,
      data: event,
      encodedSize,
    });
    this.replayBytes += encodedSize;

    this.pruneReplayLog(parseIsoToMs(at));

    return {
      kind: "event",
      seq,
      at,
      data: event,
    };
  }

  buildSnapshotFrame(
    at = new Date().toISOString(),
    sessionIds?: ReadonlySet<string>,
  ): ProviderStreamFrame {
    return {
      kind: "snapshot",
      seq: this.currentSeq,
      at,
      data: this.getSnapshot(sessionIds),
    };
  }

  buildGapFrame(
    reason: ProviderStreamGapReason,
    at = new Date().toISOString(),
  ): ProviderStreamFrame {
    return {
      kind: "gap",
      seq: this.currentSeq,
      at,
      data: {
        reason,
        oldestSeq: this.oldestSeq,
        currentSeq: this.currentSeq,
      },
    };
  }

  selectReplay(afterSeq: number, replayLimit: number): ReplaySelection {
    const currentSeq = this.currentSeq;
    const oldestSeq = this.oldestSeq;
    const minimumValidCursor = Math.max(0, oldestSeq - 1);

    if (afterSeq > currentSeq) {
      return {
        ok: false,
        currentSeq,
        oldestSeq,
        reason: "cursor_ahead",
      };
    }

    if (afterSeq < minimumValidCursor) {
      return {
        ok: false,
        currentSeq,
        oldestSeq,
        reason: "cursor_too_old",
      };
    }

    const firstMissingIndex = this.replayLog.findIndex((entry) => entry.seq > afterSeq);
    const replayStartIndex = firstMissingIndex === -1 ? this.replayLog.length : firstMissingIndex;
    const missingCount = this.replayLog.length - replayStartIndex;

    if (missingCount > replayLimit) {
      return {
        ok: false,
        currentSeq,
        oldestSeq,
        reason: "replay_limit_exceeded",
      };
    }

    const events = this.replayLog
      .slice(replayStartIndex)
      .map((entry) => ({
        seq: entry.seq,
        at: entry.at,
        data: entry.data,
      }));

    return {
      ok: true,
      currentSeq,
      oldestSeq,
      events,
    };
  }

  getSession(sessionId: string): CanonicalSessionState | undefined {
    return this.sessionsById.get(sessionId);
  }

  getSnapshot(sessionIds?: ReadonlySet<string>): ProviderSnapshot {
    const sessions = Array.from(this.sessionsById.values()).filter((session) =>
      isFromSessionFilter(sessionIds, session.sessionId),
    );
    const allowedSessionIds = new Set(sessions.map((session) => session.sessionId));

    const activeTurns = Array.from(this.activeTurnsByKey.values()).filter((turn) =>
      allowedSessionIds.has(turn.sessionId),
    );
    const activeMessages = Array.from(this.activeMessagesByKey.values()).filter((message) =>
      allowedSessionIds.has(message.sessionId),
    );
    const pendingApprovals = Array.from(this.pendingApprovalsByKey.values()).filter((approval) =>
      allowedSessionIds.has(approval.sessionId),
    );

    return {
      sessions,
      activeTurns,
      activeMessages,
      pendingApprovals,
    };
  }

  get currentSeq(): number {
    if (this.nextSeq <= 1) {
      return 0;
    }
    return this.nextSeq - 1;
  }

  get oldestSeq(): number {
    const first = this.replayLog[0];
    if (first) {
      return first.seq;
    }
    return this.currentSeq;
  }

  private pruneReplayLog(nowMs: number): void {
    while (this.replayLog.length > 0) {
      const first = this.replayLog[0];
      if (!first) {
        return;
      }

      const overCount = this.replayLog.length > PROVIDER_STREAM_MAX_REPLAY_EVENTS;
      const overBytes = this.replayBytes > PROVIDER_STREAM_MAX_REPLAY_BYTES;
      const tooOld = nowMs - parseIsoToMs(first.at) > PROVIDER_STREAM_MAX_REPLAY_AGE_MS;

      if (!overCount && !overBytes && !tooOld) {
        return;
      }

      this.replayLog.shift();
      this.replayBytes -= first.encodedSize;
    }
  }

  private applyEvent(event: ProviderCoreEvent, at: string): void {
    if (event.type === "session.updated") {
      this.sessionsById.set(event.session.sessionId, event.session);

      if (event.session.status === "closed") {
        this.removeSessionState(event.session.sessionId);
      }
      return;
    }

    if (event.type === "turn.started") {
      this.activeTurnsByKey.set(
        sessionEventKey(event.sessionId, event.turnId),
        {
          sessionId: event.sessionId,
          threadId: event.threadId,
          turnId: event.turnId,
          startedAt: event.startedAt,
          ...(event.model ? { model: event.model } : {}),
        },
      );
      return;
    }

    if (event.type === "turn.completed") {
      this.activeTurnsByKey.delete(sessionEventKey(event.sessionId, event.turnId));
      this.removeTurnTransientState(event.sessionId, event.turnId);
      return;
    }

    if (event.type === "message.delta") {
      const key = sessionEventKey(event.sessionId, event.messageId);
      const previous = this.activeMessagesByKey.get(key);
      this.activeMessagesByKey.set(key, {
        sessionId: event.sessionId,
        threadId: event.threadId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        messageId: event.messageId,
        role: "assistant",
        text: `${previous?.text ?? ""}${event.delta}`,
        startedAt: previous?.startedAt ?? at,
        updatedAt: at,
      });
      return;
    }

    if (event.type === "message.completed") {
      this.activeMessagesByKey.delete(sessionEventKey(event.sessionId, event.messageId));
      return;
    }

    if (event.type === "approval.requested") {
      this.pendingApprovalsByKey.set(
        sessionEventKey(event.sessionId, event.approvalId),
        {
          sessionId: event.sessionId,
          ...(event.threadId ? { threadId: event.threadId } : {}),
          ...(event.turnId ? { turnId: event.turnId } : {}),
          approvalId: event.approvalId,
          approvalKind: event.approvalKind,
          title: event.title,
          ...(event.detail ? { detail: event.detail } : {}),
          ...(event.payload !== undefined ? { payload: event.payload } : {}),
          ...(event.timeoutAt ? { timeoutAt: event.timeoutAt } : {}),
          requestedAt: event.requestedAt,
        },
      );
      return;
    }

    if (event.type === "approval.resolved") {
      this.pendingApprovalsByKey.delete(sessionEventKey(event.sessionId, event.approvalId));
      return;
    }
  }

  private removeSessionState(sessionId: string): void {
    for (const key of this.activeTurnsByKey.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.activeTurnsByKey.delete(key);
      }
    }

    for (const key of this.activeMessagesByKey.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.activeMessagesByKey.delete(key);
      }
    }

    for (const key of this.pendingApprovalsByKey.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.pendingApprovalsByKey.delete(key);
      }
    }
  }

  private removeTurnTransientState(sessionId: string, turnId: string): void {
    for (const [key, message] of this.activeMessagesByKey.entries()) {
      if (message.sessionId === sessionId && message.turnId === turnId) {
        this.activeMessagesByKey.delete(key);
      }
    }

    for (const [key, approval] of this.pendingApprovalsByKey.entries()) {
      if (approval.sessionId === sessionId && approval.turnId === turnId) {
        this.pendingApprovalsByKey.delete(key);
      }
    }
  }
}
