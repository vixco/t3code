import { z } from "zod";
import type { AgentConfig, AgentExit, OutputChunk } from "./agent";
import { providerKindSchema, providerSessionSchema } from "./provider";
import type {
  ProviderEvent,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderTurnStartResult,
} from "./provider";
import type { TerminalCommandInput, TerminalCommandResult } from "./terminal";
import type { NewTodoInput, Todo } from "./todo";

export const EDITORS = [
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "file-manager", label: "File Manager", command: null },
] as const;

export type EditorId = (typeof EDITORS)[number]["id"];

export const appBootstrapResultSchema = z.object({
  launchCwd: z.string().min(1),
  projectName: z.string().min(1),
  provider: providerKindSchema,
  model: z.string().min(1),
  session: providerSessionSchema,
  bootstrapError: z.string().min(1).optional(),
}).strict();

export const appHealthResultSchema = z.object({
  status: z.literal("ok"),
  launchCwd: z.string().min(1),
  sessionCount: z.number().int().min(0),
  activeClientConnected: z.boolean(),
}).strict();
export const dialogsPickFolderResultSchema = z.string().nullable();

export type AppBootstrapResult = z.infer<typeof appBootstrapResultSchema>;
export type AppHealthResult = z.infer<typeof appHealthResultSchema>;

export interface NativeApi {
  app: {
    bootstrap: () => Promise<AppBootstrapResult>;
    health: () => Promise<AppHealthResult>;
  };
  todos: {
    list: () => Promise<Todo[]>;
    add: (input: NewTodoInput) => Promise<Todo[]>;
    toggle: (id: string) => Promise<Todo[]>;
    remove: (id: string) => Promise<Todo[]>;
  };
  dialogs: {
    pickFolder: () => Promise<string | null>;
  };
  terminal: {
    run: (input: TerminalCommandInput) => Promise<TerminalCommandResult>;
  };
  agent: {
    spawn: (config: AgentConfig) => Promise<string>;
    kill: (sessionId: string) => Promise<void>;
    write: (sessionId: string, data: string) => Promise<void>;
    onOutput: (callback: (chunk: OutputChunk) => void) => () => void;
    onExit: (callback: (exit: AgentExit) => void) => () => void;
  };
  providers: {
    startSession: (input: ProviderSessionStartInput) => Promise<ProviderSession>;
    sendTurn: (input: ProviderSendTurnInput) => Promise<ProviderTurnStartResult>;
    interruptTurn: (input: ProviderInterruptTurnInput) => Promise<void>;
    respondToRequest: (input: ProviderRespondToRequestInput) => Promise<void>;
    stopSession: (input: ProviderStopSessionInput) => Promise<void>;
    listSessions: () => Promise<ProviderSession[]>;
    onEvent: (callback: (event: ProviderEvent) => void) => () => void;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
  };
}
