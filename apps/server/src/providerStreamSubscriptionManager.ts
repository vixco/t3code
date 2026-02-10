import {
  WS_CHANNELS,
  type ProviderCoreEvent,
  type ProviderStreamEventKind,
  type ProviderStreamFrame,
  type ProvidersOpenStreamInput,
  type ProvidersOpenStreamResult,
  providersOpenStreamInputSchema,
} from "@t3tools/contracts";
import type { WsPush } from "@t3tools/contracts";
import type { WebSocket } from "ws";

import {
  PROVIDER_STREAM_REPLAY_OPEN_LIMIT,
  ProviderStreamStore,
  filterEventExtensions,
  providerStreamEventKindOf,
  providerStreamEventSessionId,
} from "./providerStreamStore";

const BACKPRESSURE_HIGH_WATER_MARK_BYTES = 2 * 1_024 * 1_024;
const BACKPRESSURE_HIGH_WATER_DURATION_MS = 5_000;

interface StreamFilter {
  sessionIds?: Set<string>;
  eventKinds: Set<ProviderStreamEventKind>;
  includeExtensions: Set<string>;
  includeDebugRaw: boolean;
}

interface StreamSubscription {
  filter: StreamFilter;
  overHighWaterSinceMs: number | null;
}

interface SubscriptionManagerOptions {
  onPush?: ((push: WsPush) => void) | undefined;
}

const DEFAULT_EVENT_KINDS: ReadonlyArray<ProviderStreamEventKind> = [
  "session",
  "turn",
  "message",
  "approval",
  "activity",
  "error",
  "debug.raw",
];

function normalizeFilter(input: ProvidersOpenStreamInput): StreamFilter {
  const sessionIds = input.sessionIds && input.sessionIds.length > 0
    ? new Set(input.sessionIds)
    : undefined;
  const eventKinds = new Set(input.eventKinds ?? DEFAULT_EVENT_KINDS);

  return {
    ...(sessionIds ? { sessionIds } : {}),
    eventKinds,
    includeExtensions: new Set(input.includeExtensions ?? []),
    includeDebugRaw: input.includeDebugRaw ?? false,
  };
}

export class ProviderStreamSubscriptionManager {
  private readonly subscriptions = new Map<WebSocket, StreamSubscription>();
  private readonly onPush: ((push: WsPush) => void) | undefined;

  constructor(
    private readonly store: ProviderStreamStore,
    options: SubscriptionManagerOptions = {},
  ) {
    this.onPush = options.onPush;
  }

  openStream(
    ws: WebSocket,
    rawInput: ProvidersOpenStreamInput | undefined,
  ): ProvidersOpenStreamResult {
    const input = providersOpenStreamInputSchema.parse(rawInput ?? {});
    const filter = normalizeFilter(input);

    this.subscriptions.set(ws, {
      filter,
      overHighWaterSinceMs: null,
    });

    const nowIso = new Date().toISOString();

    if (input.afterSeq === undefined) {
      this.sendFrame(ws, {
        kind: "snapshot",
        seq: this.store.currentSeq,
        at: nowIso,
        data: this.store.getSnapshot(filter.sessionIds),
      });

      return {
        mode: "snapshot",
        currentSeq: this.store.currentSeq,
        oldestSeq: this.store.oldestSeq,
        replayedCount: 0,
      };
    }

    const replay = this.store.selectReplay(
      input.afterSeq,
      PROVIDER_STREAM_REPLAY_OPEN_LIMIT,
    );

    if (!replay.ok) {
      this.sendFrame(ws, {
        kind: "gap",
        seq: replay.currentSeq,
        at: nowIso,
        data: {
          reason: replay.reason,
          oldestSeq: replay.oldestSeq,
          currentSeq: replay.currentSeq,
        },
      });
      this.sendFrame(ws, {
        kind: "snapshot",
        seq: replay.currentSeq,
        at: nowIso,
        data: this.store.getSnapshot(filter.sessionIds),
      });

      return {
        mode: "snapshot_resync",
        currentSeq: replay.currentSeq,
        oldestSeq: replay.oldestSeq,
        replayedCount: 0,
      };
    }

    let replayedCount = 0;
    for (const event of replay.events) {
      const delivered = this.sendFrame(ws, {
        kind: "event",
        seq: event.seq,
        at: event.at,
        data: event.data,
      });
      if (delivered) {
        replayedCount += 1;
      }
    }

    return {
      mode: "replay",
      currentSeq: replay.currentSeq,
      oldestSeq: replay.oldestSeq,
      replayedCount,
    };
  }

  closeStream(ws: WebSocket): void {
    this.subscriptions.delete(ws);
  }

  closeAll(): void {
    this.subscriptions.clear();
  }

  publish(frame: ProviderStreamFrame): void {
    for (const [ws] of this.subscriptions) {
      if (!this.isSocketOpen(ws)) {
        this.subscriptions.delete(ws);
        continue;
      }
      this.sendFrame(ws, frame);
    }
  }

  private sendFrame(ws: WebSocket, frame: ProviderStreamFrame): boolean {
    const subscription = this.subscriptions.get(ws);
    if (!subscription) {
      return false;
    }

    if (!this.isSocketOpen(ws)) {
      this.subscriptions.delete(ws);
      return false;
    }

    if (!this.checkBackpressure(ws, subscription)) {
      return false;
    }

    const filteredFrame = this.filteredFrameForSubscription(frame, subscription.filter);
    if (!filteredFrame) {
      return false;
    }

    const push: WsPush = {
      type: "push",
      channel: WS_CHANNELS.providerStream,
      data: filteredFrame,
    };

    try {
      ws.send(JSON.stringify(push));
    } catch {
      this.subscriptions.delete(ws);
      try {
        ws.close();
      } catch {
        // Ignore close errors on already-failed sockets.
      }
      return false;
    }

    this.onPush?.(push);
    this.checkBackpressure(ws, subscription);
    return true;
  }

  private filteredFrameForSubscription(
    frame: ProviderStreamFrame,
    filter: StreamFilter,
  ): ProviderStreamFrame | null {
    if (frame.kind === "snapshot") {
      return {
        ...frame,
        data: this.store.getSnapshot(filter.sessionIds),
      };
    }

    if (frame.kind === "gap") {
      return frame;
    }

    if (!this.shouldIncludeEvent(frame.data, filter)) {
      return null;
    }

    return {
      ...frame,
      data: filterEventExtensions(frame.data, filter.includeExtensions),
    };
  }

  private shouldIncludeEvent(event: ProviderCoreEvent, filter: StreamFilter): boolean {
    const kind = providerStreamEventKindOf(event);

    if (!filter.eventKinds.has(kind)) {
      return false;
    }

    if (kind === "debug.raw" && !filter.includeDebugRaw) {
      return false;
    }

    if (!filter.sessionIds || filter.sessionIds.size === 0) {
      return true;
    }

    const sessionId = providerStreamEventSessionId(event);
    if (!sessionId) {
      return false;
    }

    return filter.sessionIds.has(sessionId);
  }

  private checkBackpressure(
    ws: WebSocket,
    subscription: StreamSubscription,
  ): boolean {
    const buffered = ws.bufferedAmount;
    if (buffered <= BACKPRESSURE_HIGH_WATER_MARK_BYTES) {
      subscription.overHighWaterSinceMs = null;
      return true;
    }

    const nowMs = Date.now();
    if (subscription.overHighWaterSinceMs === null) {
      subscription.overHighWaterSinceMs = nowMs;
      return true;
    }

    if (nowMs - subscription.overHighWaterSinceMs < BACKPRESSURE_HIGH_WATER_DURATION_MS) {
      return true;
    }

    this.subscriptions.delete(ws);
    try {
      ws.close(1013, "provider stream backpressure");
    } catch {
      // Ignore close errors on failed sockets.
    }
    return false;
  }

  private isSocketOpen(ws: WebSocket): boolean {
    return ws.readyState === ws.OPEN;
  }
}
