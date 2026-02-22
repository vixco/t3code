import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";

import type { AggregateType } from "./domain";

export interface PersistedEvent {
  sequence: number;
  eventId: string;
  streamId: string;
  aggregateType: AggregateType;
  version: number;
  occurredAt: string;
  causationId: string;
  correlationId: string;
  actor: string;
  eventType: string;
  payloadJson: string;
  idempotencyKey: string | null;
}

export interface AppendEventInput {
  eventId: string;
  streamId: string;
  aggregateType: AggregateType;
  expectedVersion?: number | undefined;
  occurredAt: string;
  causationId: string;
  correlationId: string;
  actor: string;
  eventType: string;
  payloadJson: string;
  idempotencyKey?: string | undefined;
}

interface EventRow {
  sequence: number;
  event_id: string;
  stream_id: string;
  aggregate_type: AggregateType;
  version: number;
  occurred_at: string;
  causation_id: string;
  correlation_id: string;
  actor: string;
  event_type: string;
  payload_json: string;
  idempotency_key: string | null;
}

function mapEventRow(row: EventRow): PersistedEvent {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    streamId: row.stream_id,
    aggregateType: row.aggregate_type,
    version: row.version,
    occurredAt: row.occurred_at,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    actor: row.actor,
    eventType: row.event_type,
    payloadJson: row.payload_json,
    idempotencyKey: row.idempotency_key,
  };
}

export class SqliteEventStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        stream_id TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        version INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        causation_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT UNIQUE
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_stream_version
      ON events(stream_id, version);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_aggregate
      ON events(aggregate_type, stream_id, version);
    `);
  }

  append(input: AppendEventInput): Effect.Effect<PersistedEvent, Error> {
    return Effect.try({
      try: () => {
        this.db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          if (input.idempotencyKey) {
            const existingByKeyRow = this.db
              .prepare(
                `SELECT sequence, event_id, stream_id, aggregate_type, version, occurred_at,
                        causation_id, correlation_id, actor, event_type, payload_json, idempotency_key
                   FROM events
                  WHERE idempotency_key = ?`,
              )
              .get(input.idempotencyKey) as EventRow | undefined;
            if (existingByKeyRow) {
              this.db.exec("COMMIT");
              return mapEventRow(existingByKeyRow);
            }
          }

          const latest = this.db
            .prepare("SELECT version FROM events WHERE stream_id = ? ORDER BY version DESC LIMIT 1")
            .get(input.streamId) as { version: number } | undefined;
          const currentVersion = latest?.version ?? 0;

          if (typeof input.expectedVersion === "number" && input.expectedVersion !== currentVersion) {
            throw new Error(
              `Optimistic concurrency conflict for stream ${input.streamId}: expected ${input.expectedVersion}, got ${currentVersion}`,
            );
          }

          const nextVersion = currentVersion + 1;
          this.db
            .prepare(
              `INSERT INTO events (
                event_id, stream_id, aggregate_type, version, occurred_at,
                causation_id, correlation_id, actor, event_type, payload_json, idempotency_key
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.eventId,
              input.streamId,
              input.aggregateType,
              nextVersion,
              input.occurredAt,
              input.causationId,
              input.correlationId,
              input.actor,
              input.eventType,
              input.payloadJson,
              input.idempotencyKey ?? null,
            );

          const persistedRow = this.db
            .prepare(
              `SELECT sequence, event_id, stream_id, aggregate_type, version, occurred_at,
                      causation_id, correlation_id, actor, event_type, payload_json, idempotency_key
                 FROM events
                WHERE event_id = ?`,
            )
            .get(input.eventId) as EventRow | undefined;
          if (!persistedRow) {
            throw new Error(`Inserted event missing from store: ${input.eventId}`);
          }
          this.db.exec("COMMIT");
          return mapEventRow(persistedRow);
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }

  listSince(minSequence: number): Effect.Effect<PersistedEvent[], Error> {
    return Effect.try({
      try: () => {
        const rows = this.db
          .prepare(
            `SELECT sequence, event_id, stream_id, aggregate_type, version, occurred_at,
                    causation_id, correlation_id, actor, event_type, payload_json, idempotency_key
               FROM events
              WHERE sequence > ?
              ORDER BY sequence ASC`,
          )
          .all(minSequence) as unknown as EventRow[];
        return rows.map((row) => mapEventRow(row));
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }

  lastSequence(): Effect.Effect<number, Error> {
    return Effect.try({
      try: () => {
        const row = this.db.prepare("SELECT MAX(sequence) as sequence FROM events").get() as
          | { sequence: number | null }
          | undefined;
        return row?.sequence ?? 0;
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }

  close(): void {
    this.db.close();
  }
}
