import { Schema } from "effect";

import { ProjectScriptSchema, ProviderEventSchema, ProviderSessionViewSchema, RuntimeModeSchema } from "./models";

export const CommandTypeSchema = Schema.Literal(
  "app.bootstrap",
  "project.add",
  "project.remove",
  "project.updateScripts",
  "thread.create",
  "thread.delete",
  "thread.addUserMessage",
  "thread.updateProviderSession",
  "thread.recordProviderEvent",
  "thread.setBranch",
  "thread.setTerminalActivity",
  "thread.markVisited",
  "runtime.setMode",
);
export type CommandType = Schema.Schema.Type<typeof CommandTypeSchema>;

export interface DomainCommand<TPayload> {
  readonly id: string;
  readonly type: CommandType;
  readonly payload: TPayload;
  readonly issuedAt: string;
  readonly correlationId?: string;
}

export interface AppBootstrapCommand
  extends DomainCommand<{
    cwd: string;
    projectName: string;
  }> {
  readonly type: "app.bootstrap";
}

export interface ProjectAddCommand
  extends DomainCommand<{
    id: string;
    name: string;
    cwd: string;
    model: string;
    scripts: Schema.Schema.Type<typeof ProjectScriptSchema>[];
  }> {
  readonly type: "project.add";
}

export interface ProjectRemoveCommand extends DomainCommand<{ id: string }> {
  readonly type: "project.remove";
}

export interface ProjectUpdateScriptsCommand
  extends DomainCommand<{
    id: string;
    scripts: Schema.Schema.Type<typeof ProjectScriptSchema>[];
  }> {
  readonly type: "project.updateScripts";
}

export interface ThreadCreateCommand
  extends DomainCommand<{
    id: string;
    projectId: string;
    title: string;
    model: string;
    createdAt: string;
    branch: string | null;
    worktreePath: string | null;
  }> {
  readonly type: "thread.create";
}

export interface ThreadDeleteCommand extends DomainCommand<{ id: string }> {
  readonly type: "thread.delete";
}

export interface ThreadAddUserMessageCommand
  extends DomainCommand<{
    threadId: string;
    messageId: string;
    text: string;
    createdAt: string;
    attachments?: Array<{
      type: "image";
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      previewUrl?: string;
    }>;
  }> {
  readonly type: "thread.addUserMessage";
}

export interface ThreadUpdateProviderSessionCommand
  extends DomainCommand<{
    threadId: string;
    session: Schema.Schema.Type<typeof ProviderSessionViewSchema> | null;
  }> {
  readonly type: "thread.updateProviderSession";
}

export interface ThreadRecordProviderEventCommand
  extends DomainCommand<{
    threadId: string;
    event: Schema.Schema.Type<typeof ProviderEventSchema>;
  }> {
  readonly type: "thread.recordProviderEvent";
}

export interface ThreadSetBranchCommand
  extends DomainCommand<{
    threadId: string;
    branch: string | null;
    worktreePath: string | null;
  }> {
  readonly type: "thread.setBranch";
}

export interface ThreadSetTerminalActivityCommand
  extends DomainCommand<{
    threadId: string;
    terminalId: string;
    running: boolean;
  }> {
  readonly type: "thread.setTerminalActivity";
}

export interface ThreadMarkVisitedCommand
  extends DomainCommand<{
    threadId: string;
    visitedAt: string;
  }> {
  readonly type: "thread.markVisited";
}

export interface RuntimeSetModeCommand
  extends DomainCommand<{
    mode: Schema.Schema.Type<typeof RuntimeModeSchema>;
  }> {
  readonly type: "runtime.setMode";
}

export type AnyDomainCommand =
  | AppBootstrapCommand
  | ProjectAddCommand
  | ProjectRemoveCommand
  | ProjectUpdateScriptsCommand
  | ThreadCreateCommand
  | ThreadDeleteCommand
  | ThreadAddUserMessageCommand
  | ThreadUpdateProviderSessionCommand
  | ThreadRecordProviderEventCommand
  | ThreadSetBranchCommand
  | ThreadSetTerminalActivityCommand
  | ThreadMarkVisitedCommand
  | RuntimeSetModeCommand;
