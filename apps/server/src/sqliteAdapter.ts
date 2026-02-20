import { createRequire } from "node:module";
import path from "node:path";

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

interface NodeSqliteModule {
  DatabaseSync: new (filename: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => SqliteStatement;
    close: () => void;
  };
}

interface BunSqliteStatement {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}

interface BunSqliteModule {
  Database: new (filename: string) => {
    exec: (sql: string) => unknown;
    query: (sql: string) => BunSqliteStatement;
    close: () => void;
  };
}

function isNodeSqliteUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ERR_UNKNOWN_BUILTIN_MODULE" || code === "MODULE_NOT_FOUND") {
    return true;
  }
  return error.message.includes("node:sqlite");
}

function openNodeSqliteDatabase(
  requireFn: ReturnType<typeof createRequire>,
  dbPath: string,
): SqliteDatabase {
  let nodeSqlite: NodeSqliteModule;
  try {
    nodeSqlite = requireFn("node:sqlite") as NodeSqliteModule;
  } catch (error) {
    if (isNodeSqliteUnavailableError(error)) {
      throw new Error(
        "node:sqlite is unavailable in this runtime. Use Node.js 22+ (or run the server with Bun).",
        { cause: error },
      );
    }
    throw error;
  }
  if (typeof nodeSqlite.DatabaseSync !== "function") {
    throw new Error(
      "node:sqlite was loaded but DatabaseSync is missing. Upgrade Node.js or run the server with Bun.",
    );
  }
  const db = new nodeSqlite.DatabaseSync(dbPath);
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    prepare: (sql) => db.prepare(sql),
    close: () => {
      db.close();
    },
  };
}

function openBunSqliteDatabase(
  requireFn: ReturnType<typeof createRequire>,
  dbPath: string,
): SqliteDatabase {
  const bunSqlite = requireFn("bun:sqlite") as BunSqliteModule;
  const db = new bunSqlite.Database(dbPath);
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    prepare: (sql) => {
      const statement = db.query(sql);
      return {
        run: (...params: unknown[]) => statement.run(...params),
        get: (...params: unknown[]) => statement.get(...params),
        all: (...params: unknown[]) => statement.all(...params),
      };
    },
    close: () => {
      db.close();
    },
  };
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
