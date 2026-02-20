import { describe, expect, test } from "vitest";

import { PersistenceInitializationError } from "./persistence/errors";
import { applyStateDbPragmas, runStateMigrations } from "./stateMigrations";
import type { SqliteDatabase, SqliteStatement } from "./sqliteAdapter";

class MockStatement implements SqliteStatement {
  run(): unknown {
    return undefined;
  }
  get(): unknown {
    return undefined;
  }
  all(): unknown[] {
    return [];
  }
}

class MockSqliteDatabase implements SqliteDatabase {
  readonly statements: string[] = [];

  exec(sql: string): void {
    this.statements.push(sql);
  }

  prepare(): SqliteStatement {
    return new MockStatement();
  }

  close(): void {
    // no-op for tests
  }
}

describe("stateMigrations", () => {
  test("applies sqlite pragmas in order", () => {
    const db = new MockSqliteDatabase();
    applyStateDbPragmas(db);
    expect(db.statements).toEqual([
      "PRAGMA journal_mode=WAL;",
      "PRAGMA synchronous=FULL;",
      "PRAGMA busy_timeout=5000;",
      "PRAGMA foreign_keys=ON;",
    ]);
  });

  test("throws when database adapter is not Effect-backed", () => {
    const db = new MockSqliteDatabase();
    expect(() => runStateMigrations(db)).toThrow(PersistenceInitializationError);
    expect(db.statements).toEqual([
      "PRAGMA journal_mode=WAL;",
      "PRAGMA synchronous=FULL;",
      "PRAGMA busy_timeout=5000;",
      "PRAGMA foreign_keys=ON;",
    ]);
  });
});
