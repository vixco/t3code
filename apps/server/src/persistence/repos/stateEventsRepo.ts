import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { stateEventSchema, type StateEvent } from "@t3tools/contracts";
import {
  StateEventRowSchema,
  StateSeqRowSchema,
  StateEventInsertStatsSchema,
} from "../schema";

interface StateEventRow {
  seq: number;
  event_type: string;
  entity_id: string;
  payload_json: string;
  created_at: string;
}

function toSafeInteger(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return fallback;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

const decodeStateEventRows = Schema.decodeUnknownSync(Schema.Array(StateEventRowSchema));
const decodeStateSeqRows = Schema.decodeUnknownSync(Schema.Array(StateSeqRowSchema));
const decodeStateEventInsertStats = Schema.decodeUnknownSync(StateEventInsertStatsSchema);

export const appendStateEvent = (input: {
  eventType: string;
  entityId: string;
  payload: unknown;
  createdAt: string;
}): Effect.Effect<StateEvent, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const result = (yield* sql
      .unsafe<{ changes?: number | bigint; lastInsertRowid?: number | bigint }>(
        "INSERT INTO state_events (event_type, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?);",
        [input.eventType, input.entityId, JSON.stringify(input.payload), input.createdAt],
      )
      .raw) as {
      changes?: number | bigint;
      lastInsertRowid?: number | bigint;
    };
    const stats = decodeStateEventInsertStats(result);

    return stateEventSchema.parse({
      seq: toSafeInteger(stats.lastInsertRowid, 0),
      eventType: input.eventType,
      entityId: input.entityId,
      payload: input.payload,
      createdAt: input.createdAt,
    });
  });

export const readLastStateSeq: Effect.Effect<number, unknown, SqlClient.SqlClient> = Effect.gen(
  function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<{ seq?: number | bigint }>(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM state_events;",
      )
      .unprepared) as Array<{ seq?: number | bigint }>;
    const parsedRows = decodeStateSeqRows(rows);
    return toSafeInteger(parsedRows[0]?.seq, 0);
  },
);

export const listStateEventsAfterSeq = (
  afterSeq: number,
): Effect.Effect<StateEvent[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<StateEventRow>(
        "SELECT seq, event_type, entity_id, payload_json, created_at FROM state_events WHERE seq > ? ORDER BY seq ASC;",
        [afterSeq],
      )
      .unprepared) as StateEventRow[];
    return decodeStateEventRows(rows).map((row) =>
      stateEventSchema.parse({
        seq: row.seq,
        eventType: row.event_type,
        entityId: row.entity_id,
        payload: tryParseJson(row.payload_json),
        createdAt: row.created_at,
      }),
    );
  });
