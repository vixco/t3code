import type { AnyDomainCommand } from "../domain/commands";
import type { DomainEventEnvelope, NewDomainEvent, StateUpdatedNotification } from "../domain/events";
import type { AppViewState } from "../domain/models";

export interface EventStorePort {
  append(events: ReadonlyArray<NewDomainEvent>): Promise<ReadonlyArray<DomainEventEnvelope>>;
  loadAll(): Promise<ReadonlyArray<DomainEventEnvelope>>;
  loadAfterPosition(position: number): Promise<ReadonlyArray<DomainEventEnvelope>>;
}

export interface ProjectionStorePort {
  readState(): Promise<AppViewState | null>;
  writeState(state: AppViewState): Promise<void>;
}

export interface FanoutPort {
  publish(notification: StateUpdatedNotification): Promise<void>;
  subscribe(): Promise<AsyncIterable<StateUpdatedNotification>>;
}

export interface DeterministicProjectorPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue(events: ReadonlyArray<DomainEventEnvelope>): Promise<void>;
}

export interface CoreApplicationPort {
  execute(command: AnyDomainCommand): Promise<AppViewState>;
  currentState(): Promise<AppViewState>;
}
