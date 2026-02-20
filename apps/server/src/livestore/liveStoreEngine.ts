import { makeAdapter } from "@livestore/adapter-node";
import { createStorePromise } from "@livestore/livestore";
import type { StateEvent } from "@t3tools/contracts";
import { createLogger } from "../logger";
import type { StateEventMirror } from "../stateSyncEngineShadow";
import { liveStoreShadowSchema } from "./materializers";
import { liveStoreShadowEvents } from "./schema";

export interface LiveStoreStateMirrorOptions {
  enabled?: boolean;
  storeId?: string;
}

interface LiveStoreShadowStore {
  commit: (event: unknown) => unknown;
  shutdown?: () => unknown;
  shutdownPromise?: () => Promise<void>;
}

export class LiveStoreStateMirror implements StateEventMirror {
  private readonly enabled: boolean;
  private readonly storeId: string;
  private readonly logger = createLogger("livestore-shadow");
  private store: LiveStoreShadowStore | null = null;
  private storePromise: Promise<LiveStoreShadowStore> | null = null;
  private lastMirroredSeq = 0;
  private disposed = false;

  constructor(options: LiveStoreStateMirrorOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.storeId = options.storeId ?? "t3-shadow-sync";
  }

  async mirrorStateEvent(event: StateEvent): Promise<void> {
    if (!this.enabled || this.disposed) {
      return;
    }
    if (event.seq <= this.lastMirroredSeq) {
      return;
    }

    const store = await this.getStore();
    if (!store) {
      return;
    }

    try {
      store.commit(
        liveStoreShadowEvents.stateEventMirrored({
          seq: event.seq,
          eventType: event.eventType,
          entityId: event.entityId,
          payloadJson: JSON.stringify(event.payload),
          createdAt: event.createdAt,
        }, "shadow"),
      );
      this.lastMirroredSeq = event.seq;
    } catch (error) {
      this.logger.warn("failed to commit mirrored state event", {
        error,
        seq: event.seq,
        eventType: event.eventType,
      });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const store = this.store;
    this.store = null;
    this.storePromise = null;
    this.lastMirroredSeq = 0;
    if (!store) {
      return;
    }
    try {
      if (typeof store.shutdownPromise === "function") {
        await store.shutdownPromise();
      } else if (typeof store.shutdown === "function") {
        const maybeResult = store.shutdown();
        if (maybeResult && typeof (maybeResult as PromiseLike<unknown>).then === "function") {
          await maybeResult;
        }
      }
    } catch (error) {
      this.logger.warn("failed to shutdown livestore shadow store", { error });
    }
  }

  private async getStore(): Promise<LiveStoreShadowStore | null> {
    if (!this.enabled || this.disposed) {
      return null;
    }

    if (!this.storePromise) {
      const adapter = makeAdapter({
        // Shadow mode is intended to validate event parity first.
        // Persisted storage can be enabled later during cutover.
        storage: { type: "in-memory" },
      });
      this.storePromise = createStorePromise({
        adapter,
        schema: liveStoreShadowSchema,
        storeId: this.storeId,
      })
        .then((store) => {
          const castStore = store as unknown as LiveStoreShadowStore;
          this.store = castStore;
          this.logger.info("initialized livestore shadow store", {
            storeId: this.storeId,
          });
          return castStore;
        })
        .catch((error) => {
          this.logger.warn("failed to initialize livestore shadow store", {
            error,
            storeId: this.storeId,
          });
          this.storePromise = null;
          return Promise.reject(error);
        });
    }

    try {
      return await this.storePromise;
    } catch {
      return null;
    }
  }
}
