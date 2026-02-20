import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger";
import { bootstrapMirrorFromCatchUp } from "./mirrorBootstrap";

describe("bootstrapMirrorFromCatchUp", () => {
  it("mirrors catch-up history into the mirror sink", () => {
    const mirrorStateEvent = vi.fn();
    const source = {
      catchUp: vi.fn().mockReturnValue({
        events: [
          {
            seq: 1,
            entityId: "project-1",
            eventType: "project.upsert",
            payload: { id: "project-1", name: "Demo", path: "/demo" },
            createdAt: new Date().toISOString(),
          },
          {
            seq: 2,
            entityId: "thread-1",
            eventType: "thread.upsert",
            payload: { id: "thread-1", title: "Thread" },
            createdAt: new Date().toISOString(),
          },
        ],
        lastStateSeq: 2,
      }),
    };

    const result = bootstrapMirrorFromCatchUp({
      source,
      mirror: { mirrorStateEvent },
      logger: createLogger("mirror-bootstrap-test"),
    });

    expect(result).toEqual({
      mirroredCount: 2,
      lastStateSeq: 2,
      complete: true,
    });
    expect(mirrorStateEvent).toHaveBeenCalledTimes(2);
  });

  it("returns partial progress when non-fatal mirroring errors occur", () => {
    const mirrorStateEvent = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("mirror write failed");
      });
    const source = {
      catchUp: vi.fn().mockReturnValue({
        events: [
          {
            seq: 1,
            entityId: "project-1",
            eventType: "project.upsert",
            payload: { id: "project-1", name: "Demo", path: "/demo" },
            createdAt: new Date().toISOString(),
          },
          {
            seq: 2,
            entityId: "thread-1",
            eventType: "thread.upsert",
            payload: { id: "thread-1", title: "Thread" },
            createdAt: new Date().toISOString(),
          },
        ],
        lastStateSeq: 2,
      }),
    };

    const result = bootstrapMirrorFromCatchUp({
      source,
      mirror: { mirrorStateEvent },
      logger: createLogger("mirror-bootstrap-test"),
    });

    expect(result).toEqual({
      mirroredCount: 1,
      lastStateSeq: 2,
      complete: false,
    });
    expect(mirrorStateEvent).toHaveBeenCalledTimes(2);
  });

  it("throws when failOnError is enabled", () => {
    const mirrorStateEvent = vi.fn().mockImplementation(() => {
      throw new Error("mirror write failed");
    });
    const source = {
      catchUp: vi.fn().mockReturnValue({
        events: [
          {
            seq: 1,
            entityId: "project-1",
            eventType: "project.upsert",
            payload: { id: "project-1", name: "Demo", path: "/demo" },
            createdAt: new Date().toISOString(),
          },
        ],
        lastStateSeq: 1,
      }),
    };

    expect(() =>
      bootstrapMirrorFromCatchUp({
        source,
        mirror: { mirrorStateEvent },
        logger: createLogger("mirror-bootstrap-test"),
        failOnError: true,
      }),
    ).toThrow(/failed to bootstrap livestore mirror/i);
  });
});
