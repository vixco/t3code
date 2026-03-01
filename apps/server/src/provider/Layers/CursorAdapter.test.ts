import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { ApprovalRequestId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { makeCursorAdapterLive } from "./CursorAdapter.ts";

class JsonLineWritable extends Writable {
  private buffer = "";

  constructor(private readonly onLine: (line: string) => void) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.buffer += chunk.toString();
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.onLine(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
    callback();
  }
}

class FakeCursorAcpProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  killed = false;

  readonly permissionSelections: Array<string> = [];
  private readonly sessionId = "acp-session-1";
  private nextPermissionRequestId = 900;

  constructor() {
    super();
    this.stdin = new JsonLineWritable((line) => this.onClientLine(line));
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.killed) return true;
    this.killed = true;
    this.emit("exit", 0, signal ?? null);
    return true;
  }

  private send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private sendSessionUpdate(sessionUpdate: Record<string, unknown>, sessionId = this.sessionId): void {
    this.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: sessionUpdate,
      },
    });
  }

  private sendPermissionRequest(sessionId = this.sessionId): void {
    const requestId = this.nextPermissionRequestId;
    this.nextPermissionRequestId += 1;
    this.send({
      jsonrpc: "2.0",
      id: requestId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          kind: "execute",
          title: "Terminal",
          command: "pwd",
        },
        options: [
          { optionId: "allow-once", title: "Allow once" },
          { optionId: "allow-always", title: "Always allow" },
          { optionId: "reject-once", title: "Reject" },
        ],
      },
    });
  }

  private onClientLine(line: string): void {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const method = typeof parsed.method === "string" ? parsed.method : undefined;
    const id = parsed.id;

    if (!method && (typeof id === "string" || typeof id === "number")) {
      const optionId =
        (parsed.result as { outcome?: { optionId?: unknown } } | undefined)?.outcome?.optionId;
      if (typeof optionId === "string") {
        this.permissionSelections.push(optionId);
      }
      return;
    }

    if (method === "initialize") {
      this.send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
          },
          authMethods: [{ id: "cursor_login" }],
        },
      });
      return;
    }

    if (method === "authenticate") {
      this.send({
        jsonrpc: "2.0",
        id,
        result: {},
      });
      return;
    }

    if (method === "session/new" || method === "session/load") {
      this.send({
        jsonrpc: "2.0",
        id,
        result: {
          sessionId: this.sessionId,
          modes: ["agent", "plan", "ask"],
        },
      });
      return;
    }

    if (method === "session/prompt") {
      const params = parsed.params as { sessionId?: unknown } | undefined;
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : this.sessionId;
      setTimeout(() => {
        this.sendSessionUpdate(
          {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "thinking..." },
          },
          sessionId,
        );
        this.sendSessionUpdate(
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from cursor" },
          },
          sessionId,
        );
        this.sendSessionUpdate(
          {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Terminal",
            kind: "execute",
            rawInput: { command: "pwd" },
          },
          sessionId,
        );
        this.sendPermissionRequest(sessionId);
        this.sendSessionUpdate(
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            status: "completed",
            rawOutput: { exitCode: 0, stdout: "/workspace\n", stderr: "" },
          },
          sessionId,
        );
        this.send({
          jsonrpc: "2.0",
          id,
          result: {
            stopReason: "end_turn",
          },
        });
      }, 0);
      return;
    }

    if (method === "session/cancel") {
      this.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: "Method not found",
        },
      });
      return;
    }

    this.send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Unsupported method: ${method ?? "unknown"}`,
      },
    });
  }
}

function makeHarness() {
  const fakeProcess = new FakeCursorAcpProcess();
  const layer = makeCursorAdapterLive({
    spawnProcess: () => fakeProcess as never,
  });
  return {
    fakeProcess,
    layer,
  };
}

describe("CursorAdapterLive", () => {
  it.effect("maps ACP lifecycle and prompt streaming to canonical v2 events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        provider: "cursor",
      });

      const turn = yield* adapter.sendTurn({
        sessionId: session.sessionId,
        input: "hello",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      assert.equal(session.threadId, "acp-session-1");
      assert.equal(turn.turnId.startsWith("cursor-turn-"), true);

      assert.equal(runtimeEvents.some((event) => event.type === "session.configured"), true);
      assert.equal(runtimeEvents.some((event) => event.type === "auth.status"), true);
      assert.equal(runtimeEvents.some((event) => event.type === "thread.started"), true);
      assert.equal(runtimeEvents.some((event) => event.type === "turn.started"), true);
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" &&
            event.payload.streamKind === "assistant_text" &&
            event.payload.delta === "hello from cursor",
        ),
        true,
      );
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "item.started" &&
            event.payload.itemType === "command_execution" &&
            event.payload.status === "inProgress",
        ),
        true,
      );
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "item.completed" &&
            event.payload.itemType === "command_execution" &&
            event.payload.status === "completed",
        ),
        true,
      );
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "turn.completed" &&
            event.turnId === turn.turnId &&
            event.payload.state === "completed",
        ),
        true,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("bridges ACP permission requests through respondToRequest", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;

      const session = yield* adapter.startSession({
        provider: "cursor",
      });

      const openedFiber = yield* Stream.filter(adapter.streamEvents, (event) => event.type === "request.opened").pipe(
        Stream.runHead,
        Effect.forkChild,
      );
      const resolvedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "request.resolved",
      ).pipe(Stream.runHead, Effect.forkChild);

      yield* adapter.sendTurn({
        sessionId: session.sessionId,
        input: "trigger permission",
        attachments: [],
      });

      const opened = yield* Fiber.join(openedFiber);
      assert.equal(opened._tag, "Some");
      if (opened._tag !== "Some" || opened.value.type !== "request.opened") {
        return;
      }
      const requestId = opened.value.requestId;
      assert.notStrictEqual(requestId, undefined);
      if (!requestId) {
        return;
      }

      yield* adapter.respondToRequest(
        session.sessionId,
        ApprovalRequestId.makeUnsafe(requestId),
        "acceptForSession",
      );

      const resolved = yield* Fiber.join(resolvedFiber);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some" || resolved.value.type !== "request.resolved") {
        return;
      }

      assert.equal(resolved.value.payload.decision, "acceptForSession");
      assert.equal(harness.fakeProcess.permissionSelections.includes("allow-always"), true);
    }).pipe(Effect.provide(harness.layer));
  });
});
