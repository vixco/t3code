import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

import type { AppViewState, DomainEventEnvelope, EventStorePort, NewDomainEvent, ProjectionStorePort } from "@t3tools/core";

interface EventRow {
  event_id: string;
  stream_id: string;
  sequence: number;
  position: number;
  type: string;
  occurred_at: string;
  payload_json: string;
  causation_id: string | null;
  correlation_id: string | null;
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseState(raw: string | null): AppViewState | null {
  if (!raw) return null;
  return JSON.parse(raw) as AppViewState;
}

export class SqliteEventStore implements EventStorePort {
  constructor(private readonly db: DatabaseSync) {}

  async append(events: ReadonlyArray<NewDomainEvent>): Promise<ReadonlyArray<DomainEventEnvelope>> {
    if (events.length === 0) return [];
    const out: DomainEventEnvelope[] = [];
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      for (const event of events) {
        const sequenceStmt = this.db.prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS nextSequence FROM events WHERE stream_id = ?",
        );
        const sequenceRow = sequenceStmt.get(event.streamId) as { nextSequence: number };
        const insert = this.db.prepare(
          [
            "INSERT INTO events(",
            "event_id, stream_id, sequence, type, occurred_at, payload_json, causation_id, correlation_id",
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ].join(" "),
        );
        const eventId = crypto.randomUUID();
        insert.run(
          eventId,
          event.streamId,
          sequenceRow.nextSequence,
          event.type,
          event.occurredAt,
          JSON.stringify(event.payload),
          event.causationId ?? null,
          event.correlationId ?? null,
        );
        const positionRow = this.db
          .prepare("SELECT position FROM events WHERE event_id = ?")
          .get(eventId) as { position: number };
        out.push({
          eventId,
          streamId: event.streamId,
          sequence: sequenceRow.nextSequence,
          position: positionRow.position,
          type: event.type,
          occurredAt: event.occurredAt,
          payload: event.payload,
          ...(event.causationId ? { causationId: event.causationId } : {}),
          ...(event.correlationId ? { correlationId: event.correlationId } : {}),
        });
      }
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async loadAll(): Promise<ReadonlyArray<DomainEventEnvelope>> {
    const stmt = this.db.prepare(
      "SELECT event_id, stream_id, sequence, position, type, occurred_at, payload_json, causation_id, correlation_id FROM events ORDER BY position ASC",
    );
    const rows = stmt.all() as unknown as EventRow[];
    return rows.map(mapEventRow);
  }

  async loadAfterPosition(position: number): Promise<ReadonlyArray<DomainEventEnvelope>> {
    const stmt = this.db.prepare(
      "SELECT event_id, stream_id, sequence, position, type, occurred_at, payload_json, causation_id, correlation_id FROM events WHERE position > ? ORDER BY position ASC",
    );
    const rows = stmt.all(position) as unknown as EventRow[];
    return rows.map(mapEventRow);
  }
}

function mapEventRow(row: EventRow): DomainEventEnvelope {
  return {
    eventId: row.event_id,
    streamId: row.stream_id,
    sequence: row.sequence,
    position: row.position,
    type: row.type as DomainEventEnvelope["type"],
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json) as DomainEventEnvelope["payload"],
    ...(row.causation_id ? { causationId: row.causation_id } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
  };
}

export class SqliteProjectionStore implements ProjectionStorePort {
  constructor(private readonly db: DatabaseSync) {}

  async readState(): Promise<AppViewState | null> {
    const row = this.db
      .prepare("SELECT state_json FROM projection_state WHERE projection_name = 'app_state'")
      .get() as { state_json: string } | undefined;
    return parseState(row?.state_json ?? null);
  }

  async writeState(state: AppViewState): Promise<void> {
    this.db
      .prepare(
        [
          "INSERT INTO projection_state(projection_name, state_json, updated_at)",
          "VALUES('app_state', ?, ?)",
          "ON CONFLICT(projection_name) DO UPDATE SET",
          "state_json = excluded.state_json,",
          "updated_at = excluded.updated_at",
        ].join(" "),
      )
      .run(JSON.stringify(state), new Date().toISOString());
  }
}

export function createSqliteStores(dbPath: string): {
  db: DatabaseSync;
  eventStore: SqliteEventStore;
  projectionStore: SqliteProjectionStore;
} {
  ensureDir(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(
    [
      "CREATE TABLE IF NOT EXISTS events(",
      "position INTEGER PRIMARY KEY AUTOINCREMENT,",
      "event_id TEXT NOT NULL UNIQUE,",
      "stream_id TEXT NOT NULL,",
      "sequence INTEGER NOT NULL,",
      "type TEXT NOT NULL,",
      "occurred_at TEXT NOT NULL,",
      "payload_json TEXT NOT NULL,",
      "causation_id TEXT,",
      "correlation_id TEXT,",
      "UNIQUE(stream_id, sequence)",
      ");",
      "CREATE INDEX IF NOT EXISTS idx_events_stream_position ON events(stream_id, position);",
      "CREATE TABLE IF NOT EXISTS projection_state(",
      "projection_name TEXT PRIMARY KEY,",
      "state_json TEXT NOT NULL,",
      "updated_at TEXT NOT NULL",
      ");",
    ].join(" "),
  );
  return {
    db,
    eventStore: new SqliteEventStore(db),
    projectionStore: new SqliteProjectionStore(db),
  };
}
