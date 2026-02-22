import type {
  CoreCommand,
  CoreDispatchInput,
  CoreDispatchResult,
  CoreGitStatusSnapshot,
  CoreReadModelSnapshot,
  CoreViewDelta,
} from "@t3tools/contracts";
import { coreCommandSchema } from "@t3tools/contracts";
import { Effect, Fiber, PubSub, Queue, Ref, Stream } from "effect";

import { handleCoreCommand } from "./commandHandlers";
import { type PersistedEvent, SqliteEventStore } from "./eventStore";
import {
  applyEventToReadModels,
  deltaFromEvent,
  emptyReadModelMaps,
  rebuildReadModels,
  toReadModelSnapshot,
  type ReadModelMaps,
} from "./readModels";

interface CommandEnvelope {
  readonly input: CoreDispatchInput;
  readonly resolve: (value: CoreDispatchResult) => void;
  readonly reject: (error: Error) => void;
}

interface CoreEngineOptions {
  readonly eventStore: SqliteEventStore;
  readonly probeGitStatus: (cwd: string) => Promise<CoreGitStatusSnapshot>;
}

export class CoreEngine {
  private readonly eventStore: SqliteEventStore;
  private readonly probeGitStatus: (cwd: string) => Promise<CoreGitStatusSnapshot>;
  private queue: Queue.Queue<CommandEnvelope> | null = null;
  private pubSub: PubSub.PubSub<CoreViewDelta> | null = null;
  private stateRef: Ref.Ref<ReadModelMaps> | null = null;
  private worker: Fiber.RuntimeFiber<void, unknown> | null = null;

  constructor(options: CoreEngineOptions) {
    this.eventStore = options.eventStore;
    this.probeGitStatus = options.probeGitStatus;
  }

  async start(): Promise<void> {
    this.queue = await Effect.runPromise(Queue.unbounded<CommandEnvelope>());
    this.pubSub = await Effect.runPromise(PubSub.unbounded<CoreViewDelta>());
    const events = await Effect.runPromise(this.eventStore.listSince(0));
    const initialState = events.length > 0 ? rebuildReadModels(events) : emptyReadModelMaps();
    this.stateRef = await Effect.runPromise(Ref.make(initialState));
    this.worker = Effect.runFork(this.commandLoop());
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await Effect.runPromise(Fiber.interrupt(this.worker));
      this.worker = null;
    }
    this.queue = null;
    this.pubSub = null;
    this.stateRef = null;
  }

  async getSnapshot(): Promise<CoreReadModelSnapshot> {
    const state = await this.getState();
    return toReadModelSnapshot(state);
  }

  async dispatch(input: CoreDispatchInput): Promise<CoreDispatchResult> {
    const queue = this.requireQueue();
    return new Promise((resolve, reject) => {
      void Effect.runPromise(
        Queue.offer(queue, {
          input,
          resolve,
          reject,
        }),
      );
    });
  }

  subscribe(listener: (delta: CoreViewDelta) => void): () => void {
    const pubSub = this.requirePubSub();
    const stream = Stream.fromPubSub(pubSub);
    const fiber = Effect.runFork(
      Stream.runForEach(stream, (delta) =>
        Effect.sync(() => {
          listener(delta);
        }),
      ),
    );
    return () => {
      void Effect.runPromise(Fiber.interrupt(fiber));
    };
  }

  private commandLoop(): Effect.Effect<void> {
    const queue = this.requireQueue();
    return Effect.forever(
      Effect.flatMap(Queue.take(queue), (envelope) =>
        Effect.tryPromise({
          try: () => this.processCommand(envelope),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    );
  }

  private async processCommand(envelope: CommandEnvelope): Promise<void> {
    try {
      const parsed = coreCommandSchema.parse(envelope.input.command);
      const events = await handleCoreCommand(parsed, {
        actor: "ws-client",
        nowIso: new Date().toISOString(),
        probeGitStatus: this.probeGitStatus,
      });

      let lastSequence = 0;
      for (const eventInput of events) {
        const persisted = await Effect.runPromise(this.eventStore.append(eventInput));
        lastSequence = persisted.sequence;
        await this.applyPersistedEvent(persisted);
      }

      envelope.resolve({
        accepted: true,
        sequence: lastSequence,
      });
    } catch (error) {
      envelope.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async applyPersistedEvent(event: PersistedEvent): Promise<void> {
    const stateRef = this.requireStateRef();
    const pubSub = this.requirePubSub();
    const nextState = await Effect.runPromise(
      Ref.updateAndGet(stateRef, (state) => applyEventToReadModels(state, event)),
    );
    const delta = deltaFromEvent(event, nextState);
    await Effect.runPromise(PubSub.publish(pubSub, delta));
  }

  private async getState(): Promise<ReadModelMaps> {
    return Effect.runPromise(Ref.get(this.requireStateRef()));
  }

  private requireQueue(): Queue.Queue<CommandEnvelope> {
    if (!this.queue) throw new Error("CoreEngine not started");
    return this.queue;
  }

  private requirePubSub(): PubSub.PubSub<CoreViewDelta> {
    if (!this.pubSub) throw new Error("CoreEngine not started");
    return this.pubSub;
  }

  private requireStateRef(): Ref.Ref<ReadModelMaps> {
    if (!this.stateRef) throw new Error("CoreEngine not started");
    return this.stateRef;
  }
}
