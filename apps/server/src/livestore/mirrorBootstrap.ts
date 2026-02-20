import type { StateCatchUpResult, StateEvent } from "@t3tools/contracts";

interface CatchUpSource {
  catchUp(input: { afterSeq: number }): StateCatchUpResult;
}

interface MirrorSink {
  mirrorStateEvent(event: StateEvent): void | Promise<void>;
}

interface LoggerLike {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface MirrorBootstrapResult {
  mirroredCount: number;
  lastStateSeq: number;
  complete: boolean;
}

export async function bootstrapMirrorFromCatchUp(options: {
  source: CatchUpSource;
  mirror: MirrorSink;
  logger: LoggerLike;
  failOnError?: boolean;
}): Promise<MirrorBootstrapResult> {
  const { source, mirror, logger, failOnError = false } = options;
  const catchUpResult = source.catchUp({ afterSeq: 0 });
  let mirroredCount = 0;
  for (const event of catchUpResult.events) {
    try {
      await mirror.mirrorStateEvent(event);
      mirroredCount += 1;
    } catch (error) {
      if (failOnError) {
        throw new Error("failed to bootstrap livestore mirror from catch-up history", {
          cause: error,
        });
      }
      logger.warn("failed to bootstrap livestore mirror event; continuing with partial mirror state", {
        error,
        eventSeq: event.seq,
        mirroredCount,
      });
      return {
        mirroredCount,
        lastStateSeq: catchUpResult.lastStateSeq,
        complete: false,
      };
    }
  }
  return {
    mirroredCount,
    lastStateSeq: catchUpResult.lastStateSeq,
    complete: true,
  };
}
