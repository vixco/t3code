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
import type { PersistenceService } from "./persistenceService";
import type { ApplyCheckpointRevertInput, StateSyncEngine } from "./stateSyncEngine";

export interface LegacyStateSyncEngineOptions {
  persistenceService: PersistenceService;
}

export class LegacyStateSyncEngine implements StateSyncEngine {
  private readonly persistenceService: PersistenceService;

  constructor(options: LegacyStateSyncEngineOptions) {
    this.persistenceService = options.persistenceService;
  }

  onStateEvent(listener: (event: StateEvent) => void): () => void {
    this.persistenceService.on("stateEvent", listener);
    return () => {
      this.persistenceService.off("stateEvent", listener);
    };
  }

  loadSnapshot(): StateBootstrapResult {
    return this.persistenceService.loadSnapshot();
  }

  listMessages(raw: StateListMessagesInput): StateListMessagesResult {
    return this.persistenceService.listMessages(raw);
  }

  catchUp(raw: StateCatchUpInput): StateCatchUpResult {
    return this.persistenceService.catchUp(raw);
  }

  getAppSettings(): AppSettings {
    return this.persistenceService.getAppSettings();
  }

  updateAppSettings(raw: AppSettingsUpdateInput): AppSettings {
    return this.persistenceService.updateAppSettings(raw);
  }

  createThread(raw: ThreadsCreateInput): ThreadsUpdateResult {
    return this.persistenceService.createThread(raw);
  }

  updateThreadTerminalState(raw: ThreadsUpdateTerminalStateInput): ThreadsUpdateResult {
    return this.persistenceService.updateThreadTerminalState(raw);
  }

  updateThreadModel(raw: ThreadsUpdateModelInput): ThreadsUpdateResult {
    return this.persistenceService.updateThreadModel(raw);
  }

  updateThreadTitle(raw: ThreadsUpdateTitleInput): ThreadsUpdateResult {
    return this.persistenceService.updateThreadTitle(raw);
  }

  updateThreadBranch(raw: ThreadsUpdateBranchInput): ThreadsUpdateResult {
    return this.persistenceService.updateThreadBranch(raw);
  }

  markThreadVisited(raw: ThreadsMarkVisitedInput): ThreadsUpdateResult {
    return this.persistenceService.markThreadVisited(raw);
  }

  deleteThread(raw: ThreadsDeleteInput): void {
    this.persistenceService.deleteThread(raw);
  }

  listProjects(): ProjectListResult {
    return this.persistenceService.listProjects();
  }

  addProject(raw: ProjectAddInput): ProjectAddResult {
    return this.persistenceService.addProject(raw);
  }

  removeProject(raw: ProjectRemoveInput): void {
    this.persistenceService.removeProject(raw);
  }

  updateProjectScripts(raw: ProjectUpdateScriptsInput): ProjectUpdateScriptsResult {
    return this.persistenceService.updateProjectScripts(raw);
  }

  applyCheckpointRevert(input: ApplyCheckpointRevertInput): void {
    this.persistenceService.applyCheckpointRevert(input);
  }

  close(): void {
    // Persistence service lifecycle is owned by server bootstrap.
  }
}
