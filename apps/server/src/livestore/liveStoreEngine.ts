import { makeAdapter } from "@livestore/adapter-node";
import { createStorePromise } from "@livestore/livestore";
import {
  stateBootstrapResultSchema,
  stateCatchUpResultSchema,
  stateListMessagesResultSchema,
  stateMessageSchema,
  stateProjectSchema,
  stateThreadSchema,
  stateTurnSummarySchema,
  type StateBootstrapResult,
  type StateCatchUpResult,
  type StateEvent,
  type StateListMessagesInput,
  type StateListMessagesResult,
} from "@t3tools/contracts";
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class LiveStoreStateMirror implements StateEventMirror {
  private readonly enabled: boolean;
  private readonly storeId: string;
  private readonly logger = createLogger("livestore-shadow");
  private store: LiveStoreShadowStore | null = null;
  private storePromise: Promise<LiveStoreShadowStore> | null = null;
  private lastMirroredSeq = 0;
  private disposed = false;
  private readonly projectsById = new Map<string, StateBootstrapResult["projects"][number]>();
  private readonly threadsById = new Map<string, StateBootstrapResult["threads"][number]>();
  private readonly threadMessagesByThreadId = new Map<
    string,
    Map<string, StateBootstrapResult["threads"][number]["messages"][number]>
  >();
  private readonly turnSummariesByThreadId = new Map<
    string,
    Map<string, StateBootstrapResult["threads"][number]["turnDiffSummaries"][number]>
  >();
  private readonly mirroredEventsBySeq = new Map<number, StateEvent>();

  constructor(options: LiveStoreStateMirrorOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.storeId = options.storeId ?? "t3-shadow-sync";
  }

  async mirrorStateEvent(event: StateEvent): Promise<boolean> {
    if (!this.enabled || this.disposed) {
      return false;
    }
    if (event.seq <= this.lastMirroredSeq) {
      return true;
    }

    const store = await this.getStore();
    if (!store) {
      return false;
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
      this.applyProjection(event);
      this.lastMirroredSeq = event.seq;
      return true;
    } catch (error) {
      this.logger.warn("failed to commit mirrored state event", {
        error,
        seq: event.seq,
        eventType: event.eventType,
      });
      return false;
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
    this.projectsById.clear();
    this.threadsById.clear();
    this.threadMessagesByThreadId.clear();
    this.turnSummariesByThreadId.clear();
    this.mirroredEventsBySeq.clear();
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

  debugReadSnapshot(): StateBootstrapResult {
    const projects = Array.from(this.projectsById.values());
    const threads = Array.from(this.threadsById.values()).map((thread) => {
      const messagesById = this.threadMessagesByThreadId.get(thread.id);
      const turnSummariesByTurnId = this.turnSummariesByThreadId.get(thread.id);
      return {
        ...thread,
        messages: messagesById
          ? Array.from(messagesById.values()).toSorted((a, b) => {
              if (a.createdAt === b.createdAt) {
                return a.id.localeCompare(b.id);
              }
              return a.createdAt.localeCompare(b.createdAt);
            })
          : [],
        turnDiffSummaries: turnSummariesByTurnId
          ? Array.from(turnSummariesByTurnId.values()).toSorted((a, b) =>
              b.completedAt.localeCompare(a.completedAt),
            )
          : [],
      };
    });

    return stateBootstrapResultSchema.parse({
      projects,
      threads,
      lastStateSeq: this.lastMirroredSeq,
    });
  }

  debugCatchUp(afterSeq: number): StateCatchUpResult {
    const events = Array.from(this.mirroredEventsBySeq.entries())
      .filter(([seq]) => seq > afterSeq)
      .sort(([a], [b]) => a - b)
      .map(([, event]) => event);
    return stateCatchUpResultSchema.parse({
      events,
      lastStateSeq: this.lastMirroredSeq,
    });
  }

  debugListMessages(raw: StateListMessagesInput): StateListMessagesResult {
    const snapshot = this.debugReadSnapshot();
    const thread = snapshot.threads.find((candidate) => candidate.id === raw.threadId);
    const messages = thread?.messages ?? [];
    const offset = Math.max(0, Math.floor(raw.offset ?? 0));
    const limit = Math.max(1, Math.floor(raw.limit ?? 200));
    const paged = messages.slice(offset, offset + limit);
    const nextOffset = offset + paged.length;
    return stateListMessagesResultSchema.parse({
      messages: paged,
      total: messages.length,
      nextOffset: nextOffset < messages.length ? nextOffset : null,
    });
  }

  private applyProjection(event: StateEvent): void {
    this.mirroredEventsBySeq.set(event.seq, event);
    const payload = asObject(event.payload);

    if (event.eventType === "project.upsert") {
      const candidate = stateProjectSchema.safeParse(payload?.project);
      if (candidate.success) {
        this.projectsById.set(candidate.data.id, candidate.data);
      }
      return;
    }

    if (event.eventType === "project.delete") {
      const projectId = asString(payload?.projectId) ?? event.entityId;
      this.projectsById.delete(projectId);
      for (const [threadId, thread] of this.threadsById.entries()) {
        if (thread.projectId !== projectId) {
          continue;
        }
        this.threadsById.delete(threadId);
        this.threadMessagesByThreadId.delete(threadId);
        this.turnSummariesByThreadId.delete(threadId);
      }
      return;
    }

    if (event.eventType === "thread.upsert") {
      const candidate = stateThreadSchema.safeParse(payload?.thread);
      if (!candidate.success) {
        return;
      }
      this.threadsById.set(candidate.data.id, {
        ...candidate.data,
        messages: [],
        turnDiffSummaries: [],
      });
      return;
    }

    if (event.eventType === "thread.delete") {
      const threadId = asString(payload?.threadId) ?? event.entityId;
      this.threadsById.delete(threadId);
      this.threadMessagesByThreadId.delete(threadId);
      this.turnSummariesByThreadId.delete(threadId);
      return;
    }

    if (event.eventType === "message.upsert") {
      const threadId = asString(payload?.threadId);
      const messageCandidate = stateMessageSchema.safeParse(payload?.message);
      if (!threadId || !messageCandidate.success) {
        return;
      }
      const byId = this.threadMessagesByThreadId.get(threadId) ?? new Map();
      byId.set(messageCandidate.data.id, messageCandidate.data);
      this.threadMessagesByThreadId.set(threadId, byId);
      return;
    }

    if (event.eventType === "message.delete") {
      const threadId = asString(payload?.threadId);
      const messageId = asString(payload?.messageId);
      if (!threadId || !messageId) {
        return;
      }
      this.threadMessagesByThreadId.get(threadId)?.delete(messageId);
      return;
    }

    if (event.eventType === "turn_summary.upsert") {
      const threadId = asString(payload?.threadId);
      const summaryCandidate = stateTurnSummarySchema.safeParse(payload?.turnSummary);
      if (!threadId || !summaryCandidate.success) {
        return;
      }
      const byTurnId = this.turnSummariesByThreadId.get(threadId) ?? new Map();
      byTurnId.set(summaryCandidate.data.turnId, summaryCandidate.data);
      this.turnSummariesByThreadId.set(threadId, byTurnId);
      return;
    }

    if (event.eventType === "turn_summary.delete") {
      const threadId = asString(payload?.threadId);
      const turnId = asString(payload?.turnId);
      if (!threadId || !turnId) {
        return;
      }
      this.turnSummariesByThreadId.get(threadId)?.delete(turnId);
    }
  }
}
