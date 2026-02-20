import { EventEmitter } from "node:events";
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
import { createLogger } from "./logger";
import type { LiveStoreStateMirror } from "./livestore/liveStoreEngine";
import { diffStateSnapshots } from "./livestore/parity";
import type { ApplyCheckpointRevertInput, StateSyncEngine } from "./stateSyncEngine";

interface LiveStoreReadPilotEvents {
  stateEvent: [event: StateEvent];
}

type LiveStoreReadSource = "delegate" | "livestore";

export interface LiveStoreReadPilotStateSyncEngineOptions {
  delegate: StateSyncEngine;
  mirror: LiveStoreStateMirror;
  enableBootstrapParityCheck?: boolean;
}

export class LiveStoreReadPilotStateSyncEngine
  extends EventEmitter<LiveStoreReadPilotEvents>
  implements StateSyncEngine
{
  private readonly delegate: StateSyncEngine;
  private readonly mirror: LiveStoreStateMirror;
  private readonly logger = createLogger("livestore-read-pilot");
  private readonly unsubscribeDelegate: () => void;
  private readonly enableBootstrapParityCheck: boolean;
  private closed = false;
  private bootstrapSource: LiveStoreReadSource = "delegate";
  private catchUpSource: LiveStoreReadSource = "delegate";
  private listMessagesSource: LiveStoreReadSource = "delegate";
  private bootstrapParityState: "unknown" | "in-parity" | "drift" = "unknown";

  constructor(options: LiveStoreReadPilotStateSyncEngineOptions) {
    super();
    this.delegate = options.delegate;
    this.mirror = options.mirror;
    this.enableBootstrapParityCheck = options.enableBootstrapParityCheck ?? false;
    this.unsubscribeDelegate = this.delegate.onStateEvent((event) => {
      this.emit("stateEvent", event);
      void this.mirror.mirrorStateEvent(event).catch((error) => {
        this.logger.warn("failed to mirror state event in read pilot", {
          error,
          seq: event.seq,
        });
      });
    });
  }

  onStateEvent(listener: (event: StateEvent) => void): () => void {
    this.on("stateEvent", listener);
    return () => {
      this.off("stateEvent", listener);
    };
  }

  loadSnapshot(): StateBootstrapResult {
    try {
      const snapshot = this.mirror.debugReadSnapshot();
      if (snapshot.lastStateSeq > 0) {
        if (this.enableBootstrapParityCheck) {
          this.checkBootstrapParity(snapshot);
        }
        this.logReadSourceChange("state.bootstrap", this.bootstrapSource, "livestore", {
          lastStateSeq: snapshot.lastStateSeq,
        });
        this.bootstrapSource = "livestore";
        return snapshot;
      }
    } catch (error) {
      this.logger.warn("failed to read bootstrap from livestore mirror; using delegate", { error });
    }
    const snapshot = this.delegate.loadSnapshot();
    this.logReadSourceChange("state.bootstrap", this.bootstrapSource, "delegate", {
      lastStateSeq: snapshot.lastStateSeq,
    });
    this.bootstrapSource = "delegate";
    return snapshot;
  }

  private checkBootstrapParity(mirrorSnapshot: StateBootstrapResult): void {
    let delegateSnapshot: StateBootstrapResult;
    try {
      delegateSnapshot = this.delegate.loadSnapshot();
    } catch (error) {
      this.logger.warn("bootstrap parity check failed to read delegate snapshot", { error });
      return;
    }

    const diffs = diffStateSnapshots(delegateSnapshot, mirrorSnapshot);
    if (diffs.length === 0) {
      if (this.bootstrapParityState !== "in-parity") {
        this.bootstrapParityState = "in-parity";
        this.logger.info("livestore read pilot bootstrap parity check passed", {
          lastStateSeq: mirrorSnapshot.lastStateSeq,
        });
      }
      return;
    }

    this.bootstrapParityState = "drift";
    this.logger.warn("livestore read pilot bootstrap parity drift detected", {
      diffCount: diffs.length,
      samplePaths: diffs.slice(0, 5).map((diff) => diff.path),
      delegateLastStateSeq: delegateSnapshot.lastStateSeq,
      mirrorLastStateSeq: mirrorSnapshot.lastStateSeq,
    });
  }

  listMessages(raw: StateListMessagesInput): StateListMessagesResult {
    try {
      const result = this.mirror.debugListMessages(raw);
      this.logReadSourceChange("state.listMessages", this.listMessagesSource, "livestore", {
        threadId: raw.threadId,
      });
      this.listMessagesSource = "livestore";
      return result;
    } catch (error) {
      this.logger.warn("failed to list messages from livestore mirror; using delegate", {
        error,
        threadId: raw.threadId,
      });
      const result = this.delegate.listMessages(raw);
      this.logReadSourceChange("state.listMessages", this.listMessagesSource, "delegate", {
        threadId: raw.threadId,
      });
      this.listMessagesSource = "delegate";
      return result;
    }
  }

  catchUp(raw: StateCatchUpInput): StateCatchUpResult {
    const afterSeq = raw.afterSeq ?? 0;
    try {
      const result = this.mirror.debugCatchUp(afterSeq);
      this.logReadSourceChange("state.catchUp", this.catchUpSource, "livestore", {
        afterSeq,
      });
      this.catchUpSource = "livestore";
      return result;
    } catch (error) {
      this.logger.warn("failed to catch up from livestore mirror; using delegate", {
        error,
        afterSeq,
      });
      const result = this.delegate.catchUp(raw);
      this.logReadSourceChange("state.catchUp", this.catchUpSource, "delegate", {
        afterSeq,
      });
      this.catchUpSource = "delegate";
      return result;
    }
  }

  private logReadSourceChange(
    route: "state.bootstrap" | "state.catchUp" | "state.listMessages",
    previous: LiveStoreReadSource,
    next: LiveStoreReadSource,
    metadata: Record<string, unknown>,
  ): void {
    if (previous === next) {
      return;
    }
    this.logger.info(`serving ${route} from ${next}`, {
      source: next,
      previousSource: previous,
      ...metadata,
    });
  }

  getAppSettings(): AppSettings {
    return this.delegate.getAppSettings();
  }

  updateAppSettings(raw: AppSettingsUpdateInput): AppSettings {
    return this.delegate.updateAppSettings(raw);
  }

  createThread(raw: ThreadsCreateInput): ThreadsUpdateResult {
    return this.delegate.createThread(raw);
  }

  updateThreadTerminalState(raw: ThreadsUpdateTerminalStateInput): ThreadsUpdateResult {
    return this.delegate.updateThreadTerminalState(raw);
  }

  updateThreadModel(raw: ThreadsUpdateModelInput): ThreadsUpdateResult {
    return this.delegate.updateThreadModel(raw);
  }

  updateThreadTitle(raw: ThreadsUpdateTitleInput): ThreadsUpdateResult {
    return this.delegate.updateThreadTitle(raw);
  }

  updateThreadBranch(raw: ThreadsUpdateBranchInput): ThreadsUpdateResult {
    return this.delegate.updateThreadBranch(raw);
  }

  markThreadVisited(raw: ThreadsMarkVisitedInput): ThreadsUpdateResult {
    return this.delegate.markThreadVisited(raw);
  }

  deleteThread(raw: ThreadsDeleteInput): void {
    this.delegate.deleteThread(raw);
  }

  listProjects(): ProjectListResult {
    return this.delegate.listProjects();
  }

  addProject(raw: ProjectAddInput): ProjectAddResult {
    return this.delegate.addProject(raw);
  }

  removeProject(raw: ProjectRemoveInput): void {
    this.delegate.removeProject(raw);
  }

  updateProjectScripts(raw: ProjectUpdateScriptsInput): ProjectUpdateScriptsResult {
    return this.delegate.updateProjectScripts(raw);
  }

  applyCheckpointRevert(input: ApplyCheckpointRevertInput): void {
    this.delegate.applyCheckpointRevert(input);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribeDelegate();
    this.removeAllListeners();
    void this.mirror.dispose();
  }
}
