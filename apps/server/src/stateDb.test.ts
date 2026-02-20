import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { StateDb } from "./stateDb";
import * as sqliteAdapter from "./sqliteAdapter";
import { STATE_DB_SCHEMA_VERSION } from "./stateMigrations";
import * as stateMigrations from "./stateMigrations";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("StateDb", () => {
  it("creates the SQLite schema and applies migrations", () => {
    const tempDir = makeTempDir("t3code-state-db-");
    const dbPath = path.join(tempDir, "state.sqlite");
    const stateDb = new StateDb({ dbPath });

    const tables = stateDb.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table';")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((table) => table.name));
    expect(tableNames.has("documents")).toBe(true);
    expect(tableNames.has("provider_events")).toBe(true);
    expect(tableNames.has("state_events")).toBe(true);
    expect(tableNames.has("metadata")).toBe(true);

    const userVersion = stateDb.db
      .prepare("PRAGMA user_version;")
      .get() as { user_version: number } | undefined;
    expect(userVersion?.user_version).toBe(STATE_DB_SCHEMA_VERSION);

    stateDb.close();
  });

  it("closes the database when migrations fail during construction", () => {
    const tempDir = makeTempDir("t3code-state-db-migration-fail-");
    const dbPath = path.join(tempDir, "state.sqlite");
    const close = vi.fn();
    const fakeDb = {
      exec: vi.fn(),
      prepare: vi.fn(),
      close,
    };
    vi.spyOn(sqliteAdapter, "openSqliteDatabase").mockReturnValue(
      fakeDb as unknown as sqliteAdapter.SqliteDatabase,
    );
    vi.spyOn(stateMigrations, "runStateMigrations").mockImplementation(() => {
      throw new Error("migration failed");
    });

    expect(() => new StateDb({ dbPath })).toThrow("migration failed");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("preserves the original transaction error when rollback fails", () => {
    const tempDir = makeTempDir("t3code-state-db-rollback-fail-");
    const dbPath = path.join(tempDir, "state.sqlite");
    const rollbackError = new Error("rollback failed");
    const exec = vi.fn((sql: string) => {
      if (sql === "ROLLBACK;") {
        throw rollbackError;
      }
    });
    const fakeDb = {
      exec,
      prepare: vi.fn(),
      close: vi.fn(),
    };
    vi.spyOn(sqliteAdapter, "openSqliteDatabase").mockReturnValue(
      fakeDb as unknown as sqliteAdapter.SqliteDatabase,
    );
    vi.spyOn(stateMigrations, "runStateMigrations").mockImplementation(() => {});

    const stateDb = new StateDb({ dbPath });
    const originalError = new Error("operation failed");

    let thrown: unknown;
    try {
      stateDb.transaction(() => {
        throw originalError;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(originalError);
    expect(exec).toHaveBeenCalledWith("ROLLBACK;");
    stateDb.close();
  });
});
