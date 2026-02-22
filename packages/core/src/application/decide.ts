import type { AnyDomainCommand } from "../domain/commands";
import type { NewDomainEvent } from "../domain/events";
import type { AppViewState } from "../domain/models";

function eventFromCommand(
  command: AnyDomainCommand,
  eventType: NewDomainEvent["type"],
  payload: NewDomainEvent["payload"],
  streamId: string,
): NewDomainEvent {
  return {
    streamId,
    type: eventType,
    payload,
    occurredAt: command.issuedAt,
    ...(command.id ? { causationId: command.id } : {}),
    ...(command.correlationId ? { correlationId: command.correlationId } : {}),
  };
}

function streamIdFromCommand(command: AnyDomainCommand): string {
  switch (command.type) {
    case "app.bootstrap":
    case "runtime.setMode":
      return "app";
    case "project.add":
    case "project.remove":
    case "project.updateScripts":
      return `project:${command.payload.id}`;
    case "thread.create":
    case "thread.delete":
      return `thread:${command.payload.id}`;
    case "thread.addUserMessage":
    case "thread.updateProviderSession":
    case "thread.recordProviderEvent":
    case "thread.setBranch":
    case "thread.setTerminalActivity":
    case "thread.markVisited":
      return `thread:${command.payload.threadId}`;
    default:
      return "app";
  }
}

export function decide(command: AnyDomainCommand, currentState: AppViewState): ReadonlyArray<NewDomainEvent> {
  switch (command.type) {
    case "app.bootstrap": {
      if (currentState.projects.length > 0) return [];
      return [eventFromCommand(command, "app.bootstrapped", command.payload, streamIdFromCommand(command))];
    }
    case "project.add":
      return [eventFromCommand(command, "project.added", command.payload, streamIdFromCommand(command))];
    case "project.remove":
      return [eventFromCommand(command, "project.removed", command.payload, streamIdFromCommand(command))];
    case "project.updateScripts":
      return [eventFromCommand(command, "project.scriptsUpdated", command.payload, streamIdFromCommand(command))];
    case "thread.create":
      return [eventFromCommand(command, "thread.created", command.payload, streamIdFromCommand(command))];
    case "thread.delete":
      return [eventFromCommand(command, "thread.deleted", command.payload, streamIdFromCommand(command))];
    case "thread.addUserMessage":
      return [eventFromCommand(command, "thread.userMessageAdded", command.payload, streamIdFromCommand(command))];
    case "thread.updateProviderSession":
      return [eventFromCommand(command, "thread.providerSessionUpdated", command.payload, streamIdFromCommand(command))];
    case "thread.recordProviderEvent":
      return [eventFromCommand(command, "thread.providerEventRecorded", command.payload, streamIdFromCommand(command))];
    case "thread.setBranch":
      return [eventFromCommand(command, "thread.branchSet", command.payload, streamIdFromCommand(command))];
    case "thread.setTerminalActivity":
      return [eventFromCommand(command, "thread.terminalActivitySet", command.payload, streamIdFromCommand(command))];
    case "thread.markVisited":
      return [eventFromCommand(command, "thread.markVisited", command.payload, streamIdFromCommand(command))];
    case "runtime.setMode":
      return [eventFromCommand(command, "runtime.modeSet", command.payload, streamIdFromCommand(command))];
    default:
      return [];
  }
}
