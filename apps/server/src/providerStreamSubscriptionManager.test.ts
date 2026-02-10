import { describe, expect, it, vi } from "vitest";

import { ProviderStreamStore } from "./providerStreamStore";
import { ProviderStreamSubscriptionManager } from "./providerStreamSubscriptionManager";

interface FakeSocket {
  OPEN: number;
  readyState: number;
  bufferedAmount: number;
  sent: unknown[];
  send: (payload: string) => void;
  close: ReturnType<typeof vi.fn>;
}

function makeSocket(): FakeSocket {
  const socket: FakeSocket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(payload: string) {
      this.sent.push(JSON.parse(payload));
    },
    close: vi.fn(function close() {
      socket.readyState = 3;
    }),
  };
  return socket;
}

function lastPush(socket: FakeSocket): Record<string, unknown> {
  const last = socket.sent.at(-1);
  if (!last || typeof last !== "object") {
    throw new Error("no push payload found");
  }
  return last as Record<string, unknown>;
}

describe("ProviderStreamSubscriptionManager", () => {
  it("opens with snapshot mode and emits snapshot frame", () => {
    const store = new ProviderStreamStore();
    store.appendEvent({
      type: "session.updated",
      session: {
        sessionId: "sess-1",
        provider: "codex",
        status: "ready",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
    });

    const manager = new ProviderStreamSubscriptionManager(store);
    const socket = makeSocket();

    const result = manager.openStream(socket as never, undefined);
    expect(result.mode).toBe("snapshot");

    const push = lastPush(socket);
    expect(push.channel).toBe("providers.stream");
    expect((push.data as { kind: string }).kind).toBe("snapshot");
  });

  it("replays missing events for valid cursor", () => {
    const store = new ProviderStreamStore();
    store.appendEvent({
      type: "session.updated",
      session: {
        sessionId: "sess-1",
        provider: "codex",
        status: "ready",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
    });
    store.appendEvent({
      type: "error",
      sessionId: "sess-1",
      code: "runtime/error",
      message: "boom",
    });

    const manager = new ProviderStreamSubscriptionManager(store);
    const socket = makeSocket();

    const result = manager.openStream(socket as never, { afterSeq: 1 });
    expect(result.mode).toBe("replay");
    expect(result.replayedCount).toBe(1);

    const push = lastPush(socket);
    expect((push.data as { kind: string }).kind).toBe("event");
  });

  it("returns snapshot_resync for stale cursors", () => {
    const store = new ProviderStreamStore();
    for (let i = 0; i < 12_000; i += 1) {
      store.appendEvent({
        type: "error",
        sessionId: "sess-1",
        code: "runtime/error",
        message: `err-${i}`,
      });
    }

    const manager = new ProviderStreamSubscriptionManager(store);
    const socket = makeSocket();

    const result = manager.openStream(socket as never, { afterSeq: 0 });
    expect(result.mode).toBe("snapshot_resync");

    const kinds = socket.sent
      .map((payload) => ((payload as Record<string, unknown>).data as { kind: string }).kind);
    expect(kinds).toContain("gap");
    expect(kinds).toContain("snapshot");
  });

  it("filters by session and debug flags", () => {
    const store = new ProviderStreamStore();
    const manager = new ProviderStreamSubscriptionManager(store);
    const socket = makeSocket();

    manager.openStream(socket as never, {
      sessionIds: ["sess-1"],
      includeDebugRaw: false,
    });

    manager.publish(
      store.appendEvent({
        type: "error",
        sessionId: "sess-2",
        code: "runtime/error",
        message: "hidden",
      }),
    );

    manager.publish(
      store.appendEvent({
        type: "debug.raw",
        provider: "codex",
        sessionId: "sess-1",
        method: "thread/started",
        payload: null,
      }),
    );

    manager.publish(
      store.appendEvent({
        type: "error",
        sessionId: "sess-1",
        code: "runtime/error",
        message: "visible",
      }),
    );

    const pushedKinds = socket.sent
      .map((payload) => ((payload as Record<string, unknown>).data as { kind: string }).kind)
      .filter((kind) => kind === "event");

    // Only the final sess-1 error event should pass filters.
    expect(pushedKinds).toHaveLength(1);
  });
});
