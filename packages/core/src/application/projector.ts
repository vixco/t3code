import type { DomainEventEnvelope } from "../domain/events";
import { emptyAppViewState, type AppViewState } from "../domain/models";
import type { FanoutPort, ProjectionStorePort } from "../ports";
import { reduceEvents } from "../projections/reducer";

export class QueueProjector {
  private readonly queue: ReadonlyArray<DomainEventEnvelope>[] = [];
  private processing = false;
  private stopSignal = false;

  constructor(
    private readonly projectionStore: ProjectionStorePort,
    private readonly fanout: FanoutPort,
  ) {}

  async start(): Promise<void> {
    if (this.processing) return;
    this.stopSignal = false;
    this.processing = true;
    void this.drain();
  }

  async stop(): Promise<void> {
    this.stopSignal = true;
    this.processing = false;
  }

  async enqueue(events: ReadonlyArray<DomainEventEnvelope>): Promise<void> {
    if (events.length === 0) return;
    this.queue.push(events);
    if (this.processing) {
      void this.drain();
    }
  }

  async readState(): Promise<AppViewState> {
    return (await this.projectionStore.readState()) ?? emptyAppViewState();
  }

  private async drain(): Promise<void> {
    if (!this.processing) return;
    while (!this.stopSignal && this.queue.length > 0) {
      const chunk = this.queue.shift();
      if (!chunk || chunk.length === 0) continue;
      const current = (await this.projectionStore.readState()) ?? emptyAppViewState();
      const next = reduceEvents(chunk, current);
      await this.projectionStore.writeState(next);
      await this.fanout.publish({ state: next, events: chunk });
    }
  }
}
