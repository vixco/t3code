import { createRequire } from "node:module";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface SqliteStatement {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}

export interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

export interface EffectSqliteDatabaseAdapter extends SqliteDatabase {
  runWithSqlClient: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => A;
}

interface SqliteDriverModule {
  SqliteClient?: {
    layer: (config: { filename: string }) => Layer.Layer<SqlClient.SqlClient>;
  };
}

function isNodeSqliteUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ERR_UNKNOWN_BUILTIN_MODULE" || code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
    return true;
  }
  return (
    error.message.includes("node:sqlite") ||
    error.message.includes("@effect/sql-sqlite-node") ||
    error.message.includes("Only URLs with a scheme in: file, data, and node")
  );
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

function toSafeInteger(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return fallback;
}

class EffectSqliteDatabase implements SqliteDatabase {
  private readonly scope: Scope.Closeable;
  private readonly services: ServiceMap.ServiceMap<SqlClient.SqlClient>;
  private readonly sql: SqlClient.SqlClient;
  private closed = false;

  constructor(layer: Layer.Layer<SqlClient.SqlClient>) {
    this.scope = Effect.runSync(Scope.make());
    try {
      this.services = Effect.runSync(Layer.buildWithScope(layer, this.scope));
      this.sql = Effect.runSync(
        Effect.provideServices(Effect.service(SqlClient.SqlClient), this.services),
      );
    } catch (error) {
      try {
        Effect.runSync(Scope.close(this.scope, Exit.void));
      } catch {
        // Best effort cleanup on failed adapter construction.
      }
      throw error;
    }
  }

  exec(sql: string): void {
    for (const statement of normalizeStatementBatch(sql)) {
      this.runEffect(this.sql.unsafe(statement).raw);
    }
  }

  prepare(sql: string): SqliteStatement {
    return {
      run: (...params: unknown[]) => this.runStatement(sql, params),
      get: (...params: unknown[]) => {
        const rows = this.queryStatement(sql, params);
        return rows[0];
      },
      all: (...params: unknown[]) => this.queryStatement(sql, params),
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    Effect.runSync(Scope.close(this.scope, Exit.void));
  }

  runWithSqlClient<A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): A {
    return this.runEffect(effect);
  }

  private runStatement(sql: string, params: ReadonlyArray<unknown>): unknown {
    this.runEffect(this.sql.unsafe(sql, params).raw);
    const stats = this.runEffect(
      this.sql
        .unsafe<{ changes?: number | bigint; lastInsertRowid?: number | bigint }>(
          "SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid;",
        )
        .unprepared,
    )[0];
    return {
      changes: toSafeInteger(stats?.changes, 0),
      lastInsertRowid: toSafeInteger(stats?.lastInsertRowid, 0),
    };
  }

  private queryStatement(sql: string, params: ReadonlyArray<unknown>): unknown[] {
    return this.runEffect(this.sql.unsafe(sql, params).unprepared) as unknown[];
  }

  private runEffect<A, E, R>(effect: Effect.Effect<A, E, R>): A {
    const provided = Effect.provideServices(effect, this.services) as Effect.Effect<A, E, never>;
    return Effect.runSync(provided);
  }
}

function openDriverDatabase(
  requireFn: ReturnType<typeof createRequire>,
  moduleId: string,
  dbPath: string,
): SqliteDatabase {
  const sqliteDriver = requireFn(moduleId) as SqliteDriverModule;
  const layer = sqliteDriver.SqliteClient?.layer;
  if (typeof layer !== "function") {
    throw new Error(`${moduleId} was loaded but SqliteClient.layer is missing.`);
  }
  return new EffectSqliteDatabase(layer({ filename: dbPath })) satisfies EffectSqliteDatabaseAdapter;
}

function openNodeSqliteDatabase(
  requireFn: ReturnType<typeof createRequire>,
  dbPath: string,
): SqliteDatabase {
  try {
    return openDriverDatabase(requireFn, "@effect/sql-sqlite-node", dbPath);
  } catch (error) {
    if (isNodeSqliteUnavailableError(error)) {
      throw new Error(
        "@effect/sql-sqlite-node is unavailable in this runtime. Ensure dependencies are installed and use Node.js 22+ (or run the server with Bun).",
        { cause: error },
      );
    }
    throw error;
  }
}

function openBunSqliteDatabase(
  requireFn: ReturnType<typeof createRequire>,
  dbPath: string,
): SqliteDatabase {
  return openDriverDatabase(requireFn, "@effect/sql-sqlite-bun", dbPath);
}

export function openSqliteDatabase(
  dbPath: string,
  requireFn: ReturnType<typeof createRequire> = createRequire(
    path.join(process.cwd(), "t3code-sqlite-adapter.cjs"),
  ),
  runtimeIsBun = Boolean(process.versions.bun),
): SqliteDatabase {
  if (runtimeIsBun) {
    // Development mode runs in Bun, so use Bun's SQLite adapter
    return openBunSqliteDatabase(requireFn, dbPath);
  }

  return openNodeSqliteDatabase(requireFn, dbPath);
}
