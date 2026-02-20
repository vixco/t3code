import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { EffectSqliteDatabaseAdapter, SqliteDatabase } from "./sqliteAdapter";

export const STATE_DB_SCHEMA_VERSION = 1;

const MIGRATION_V1_SQL = `
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    project_id TEXT NULL,
    thread_id TEXT NULL,
    sort_key INTEGER NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS provider_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    method TEXT NOT NULL,
    thread_id TEXT NULL,
    turn_id TEXT NULL,
    item_id TEXT NULL,
    request_id TEXT NULL,
    request_kind TEXT NULL,
    text_delta TEXT NULL,
    message TEXT NULL,
    payload_json TEXT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS state_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind);
  CREATE INDEX IF NOT EXISTS idx_documents_project_kind ON documents(project_id, kind);
  CREATE INDEX IF NOT EXISTS idx_documents_thread_kind_sort ON documents(thread_id, kind, sort_key);
  CREATE INDEX IF NOT EXISTS idx_documents_kind_updated ON documents(kind, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_provider_events_session_seq ON provider_events(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_provider_events_thread_seq ON provider_events(thread_id, seq);
  CREATE INDEX IF NOT EXISTS idx_state_events_seq ON state_events(seq);
`;

export function applyStateDbPragmas(db: SqliteDatabase): void {
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=FULL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA foreign_keys=ON;");
}

function readUserVersion(db: SqliteDatabase): number {
  const row = db.prepare("PRAGMA user_version;").get() as { user_version?: number } | undefined;
  const value = row?.user_version;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return 0;
  }
  return value;
}

function normalizeStatementBatch(sql: string): string[] {
  const normalized = sql.replace(/\r\n/g, "\n");
  const statements: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;

  for (const char of normalized) {
    if (char === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }
    if (char === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }
    if (char === "`" && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
      current += char;
      continue;
    }
    if (char === ";" && !inSingleQuote && !inDoubleQuote && !inBacktick) {
      const statement = current.trim();
      if (statement.length > 0) {
        statements.push(statement);
      }
      current = "";
      continue;
    }
    current += char;
  }

  const trailing = current.trim();
  if (trailing.length > 0) {
    statements.push(trailing);
  }
  return statements;
}

function migrationV1(db: SqliteDatabase): void {
  db.exec(MIGRATION_V1_SQL);
}

function isEffectSqliteDatabase(db: SqliteDatabase): db is EffectSqliteDatabaseAdapter {
  return "runWithSqlClient" in db && typeof db.runWithSqlClient === "function";
}

function runEffectMigrations(db: EffectSqliteDatabaseAdapter): void {
  const migrationV1Effect = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of normalizeStatementBatch(MIGRATION_V1_SQL)) {
      yield* sql.unsafe(statement).raw;
    }
    yield* sql.unsafe(`PRAGMA user_version=${STATE_DB_SCHEMA_VERSION};`).raw;
  });

  const migrationLoader = Migrator.fromRecord({
    "0001_initial_schema": migrationV1Effect,
  });
  const runMigrations = Migrator.make({});

  db.runWithSqlClient(
    runMigrations({ loader: migrationLoader }).pipe(
      Effect.mapError((error) => {
        const message =
          error instanceof Error
            ? error.message
            : `Failed to run Effect SQL migrations for state database.`;
        return new Error(message, { cause: error });
      }),
    ),
  );
}

export function runStateMigrations(db: SqliteDatabase): void {
  applyStateDbPragmas(db);

  if (isEffectSqliteDatabase(db)) {
    runEffectMigrations(db);
    return;
  }

  const userVersion = readUserVersion(db);
  if (userVersion >= STATE_DB_SCHEMA_VERSION) {
    return;
  }

  db.exec("BEGIN IMMEDIATE;");
  try {
    if (userVersion < 1) {
      migrationV1(db);
    }
    db.exec(`PRAGMA user_version=${STATE_DB_SCHEMA_VERSION};`);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
