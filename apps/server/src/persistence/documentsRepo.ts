import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface DocumentRow {
  id: string;
  kind: string;
  project_id: string | null;
  thread_id: string | null;
  sort_key: number | null;
  created_at: string;
  updated_at: string;
  data_json: string;
}

export const getDocumentRowById = (
  id: string,
): Effect.Effect<DocumentRow | null, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<DocumentRow>(
        "SELECT id, kind, project_id, thread_id, sort_key, created_at, updated_at, data_json FROM documents WHERE id = ? LIMIT 1;",
        [id],
      )
      .unprepared) as DocumentRow[];
    return rows[0] ?? null;
  });

export const upsertDocument = (input: {
  id: string;
  kind: "project" | "thread" | "message" | "turn_summary";
  projectId: string | null;
  threadId: string | null;
  sortKey: number | null;
  createdAt: string;
  updatedAt: string;
  dataJson: string;
}): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql
      .unsafe(
        `INSERT INTO documents (
          id,
          kind,
          project_id,
          thread_id,
          sort_key,
          schema_version,
          created_at,
          updated_at,
          data_json
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          sort_key = excluded.sort_key,
          schema_version = excluded.schema_version,
          updated_at = excluded.updated_at,
          data_json = excluded.data_json;`,
        [
          input.id,
          input.kind,
          input.projectId,
          input.threadId,
          input.sortKey,
          input.createdAt,
          input.updatedAt,
          input.dataJson,
        ],
      )
      .raw;
  }).pipe(Effect.asVoid);

export const readNextSortKey = (
  kind: "message" | "turn_summary",
  threadId: string,
): Effect.Effect<number, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<{ next_sort_key?: number }>(
        "SELECT COALESCE(MAX(sort_key), 0) + 1 AS next_sort_key FROM documents WHERE kind = ? AND thread_id = ?;",
        [kind, threadId],
      )
      .unprepared) as Array<{ next_sort_key?: number }>;
    return rows[0]?.next_sort_key ?? 1;
  });

export const listMessagePayloadsForThread = (
  threadId: string,
): Effect.Effect<string[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<{ data_json: string }>(
        "SELECT data_json FROM documents WHERE kind = 'message' AND thread_id = ? ORDER BY sort_key ASC;",
        [threadId],
      )
      .unprepared) as Array<{ data_json: string }>;
    return rows.map((row) => row.data_json);
  });

export const listMessagePayloadsForThreadDesc = (
  threadId: string,
): Effect.Effect<string[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<{ data_json: string }>(
        `SELECT data_json
         FROM documents
         WHERE kind = 'message' AND thread_id = ?
         ORDER BY sort_key DESC, updated_at DESC;`,
        [threadId],
      )
      .unprepared) as Array<{ data_json: string }>;
    return rows.map((row) => row.data_json);
  });

export const listTurnSummaryPayloadsForThread = (
  threadId: string,
): Effect.Effect<string[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<{ data_json: string }>(
        "SELECT data_json FROM documents WHERE kind = 'turn_summary' AND thread_id = ? ORDER BY sort_key DESC, updated_at DESC;",
        [threadId],
      )
      .unprepared) as Array<{ data_json: string }>;
    return rows.map((row) => row.data_json);
  });
