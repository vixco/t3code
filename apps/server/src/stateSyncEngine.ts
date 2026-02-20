import type {
  AppSettings,
  AppSettingsUpdateInput,
  ProjectAddInput,
  ProjectAddResult,
  ProjectListResult,
  ProjectRemoveInput,
  ProjectUpdateScriptsInput,
  ProjectUpdateScriptsResult,
  StateBootstrapResult,
  StateCatchUpInput,
  StateCatchUpResult,
  StateEvent,
  StateListMessagesInput,
  StateListMessagesResult,
  ThreadsCreateInput,
  ThreadsDeleteInput,
  ThreadsMarkVisitedInput,
  ThreadsUpdateBranchInput,
  ThreadsUpdateModelInput,
  ThreadsUpdateResult,
  ThreadsUpdateTerminalStateInput,
  ThreadsUpdateTitleInput,
} from "@t3tools/contracts";

export interface ApplyCheckpointRevertInput {
  sessionId: string;
  runtimeThreadId: string;
  turnCount: number;
  messageCount: number;
}

export interface StateSyncEngine {
  onStateEvent(listener: (event: StateEvent) => void): () => void;
  loadSnapshot(): StateBootstrapResult;
  listMessages(raw: StateListMessagesInput): StateListMessagesResult;
  catchUp(raw: StateCatchUpInput): StateCatchUpResult;
  getAppSettings(): AppSettings;
  updateAppSettings(raw: AppSettingsUpdateInput): AppSettings;
  createThread(raw: ThreadsCreateInput): ThreadsUpdateResult;
  updateThreadTerminalState(raw: ThreadsUpdateTerminalStateInput): ThreadsUpdateResult;
  updateThreadModel(raw: ThreadsUpdateModelInput): ThreadsUpdateResult;
  updateThreadTitle(raw: ThreadsUpdateTitleInput): ThreadsUpdateResult;
  updateThreadBranch(raw: ThreadsUpdateBranchInput): ThreadsUpdateResult;
  markThreadVisited(raw: ThreadsMarkVisitedInput): ThreadsUpdateResult;
  deleteThread(raw: ThreadsDeleteInput): void;
  listProjects(): ProjectListResult;
  addProject(raw: ProjectAddInput): ProjectAddResult;
  removeProject(raw: ProjectRemoveInput): void;
  updateProjectScripts(raw: ProjectUpdateScriptsInput): ProjectUpdateScriptsResult;
  applyCheckpointRevert(input: ApplyCheckpointRevertInput): void;
  close(): void;
}
