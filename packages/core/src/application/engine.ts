import { emptyAppViewState, type AppViewState } from "../domain/models";
import type { AnyDomainCommand } from "../domain/commands";
import { decide } from "./decide";
import type { EventStorePort, ProjectionStorePort } from "../ports";
import { QueueProjector } from "./projector";
import { reduceEvents } from "../projections/reducer";

export class OrchestrationEngine {
  constructor(
    private readonly eventStore: EventStorePort,
    projectionStore: ProjectionStorePort,
    private readonly projector: QueueProjector,
  ) {
    this.projectionStore = projectionStore;
  }

  private readonly projectionStore: ProjectionStorePort;

  async start(): Promise<void> {
    const state = await this.projectionStore.readState();
    if (!state) {
      const allEvents = await this.eventStore.loadAll();
      const next = allEvents.length === 0 ? emptyAppViewState() : reduceEvents(allEvents, emptyAppViewState());
      await this.projectionStore.writeState(next);
    }
    await this.projector.start();
    const pending = await this.eventStore.loadAfterPosition((await this.currentState()).lastPosition);
    if (pending.length > 0) {
      await this.projector.enqueue(pending);
    }
  }

  async stop(): Promise<void> {
    await this.projector.stop();
  }

  async execute(command: AnyDomainCommand): Promise<AppViewState> {
    const current = await this.currentState();
    const pending = decide(command, current);
    if (pending.length === 0) return current;
    const appended = await this.eventStore.append(pending);
    await this.projector.enqueue(appended);
    return this.currentState();
  }

  async currentState(): Promise<AppViewState> {
    return this.projector.readState();
  }
}
