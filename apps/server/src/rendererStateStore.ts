import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type RendererStateSetInput,
  type RendererStateSnapshot,
  rendererStateSetInputSchema,
  rendererStateSnapshotSchema,
} from "@t3tools/contracts";

interface RowShape {
  stateJson: string;
  updatedAt: string;
}

interface SqliteAdapter {
  getState(): RowShape | null;
  setState(stateJson: string, updatedAt: string): void;
  close(): void;
}

interface BunSqliteDatabase {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): unknown;
  query(sql: string): {
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

interface BunSqliteModule {
  Database: new (filename?: string) => BunSqliteDatabase;
}

function defaultStateDir(): string {
  return path.join(os.homedir(), ".t3", "userdata");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRowShape(row: unknown): RowShape | null {
  if (!isObject(row)) return null;
  const stateJson = row.stateJson;
  const updatedAt = row.updatedAt;
  if (typeof stateJson !== "string" || typeof updatedAt !== "string") return null;
  return { stateJson, updatedAt };
}

async function createNodeSqliteAdapter(dbPath: string): Promise<SqliteAdapter> {
  const module = await import("node:sqlite");
  const db = new module.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS renderer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const selectStatement = db.prepare(`
    SELECT state_json AS stateJson, updated_at AS updatedAt
    FROM renderer_state
    WHERE id = 1
  `);
  const upsertStatement = db.prepare(`
    INSERT INTO renderer_state (id, state_json, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `);

  return {
    getState() {
      return parseRowShape(selectStatement.get());
    },
    setState(stateJson: string, updatedAt: string) {
      upsertStatement.run(stateJson, updatedAt);
    },
    close() {
      db.close();
    },
  };
}

async function createBunSqliteAdapter(dbPath: string): Promise<SqliteAdapter> {
  const loadBunSqlite = new Function(
    "return import('bun:sqlite')",
  ) as () => Promise<BunSqliteModule>;
  const module = await loadBunSqlite();
  const db = new module.Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS renderer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const selectQuery = db.query(`
    SELECT state_json AS stateJson, updated_at AS updatedAt
    FROM renderer_state
    WHERE id = 1
  `);
  const upsertSql = `
    INSERT INTO renderer_state (id, state_json, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `;

  return {
    getState() {
      return parseRowShape(selectQuery.get());
    },
    setState(stateJson: string, updatedAt: string) {
      db.run(upsertSql, stateJson, updatedAt);
    },
    close() {
      db.close();
    },
  };
}

async function createSqliteAdapter(dbPath: string): Promise<SqliteAdapter> {
  try {
    return await createNodeSqliteAdapter(dbPath);
  } catch {
    return createBunSqliteAdapter(dbPath);
  }
}

export class RendererStateStore {
  private readonly stateDir: string;
  private readonly dbPath: string;
  private adapterPromise: Promise<SqliteAdapter> | null = null;

  constructor(stateDir: string = defaultStateDir()) {
    this.stateDir = stateDir;
    this.dbPath = path.join(this.stateDir, "renderer-state.sqlite");
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  async get(): Promise<RendererStateSnapshot | null> {
    const adapter = await this.getAdapter();
    const row = adapter.getState();
    if (!row) return null;
    const parsed = rendererStateSnapshotSchema.safeParse(row);
    if (!parsed.success) return null;
    return parsed.data;
  }

  async set(raw: RendererStateSetInput): Promise<void> {
    const input = rendererStateSetInputSchema.parse(raw);
    const adapter = await this.getAdapter();
    adapter.setState(input.stateJson, new Date().toISOString());
  }

  async close(): Promise<void> {
    if (!this.adapterPromise) return;
    const adapter = await this.adapterPromise;
    adapter.close();
    this.adapterPromise = null;
  }

  private async getAdapter(): Promise<SqliteAdapter> {
    if (!this.adapterPromise) {
      this.adapterPromise = createSqliteAdapter(this.dbPath);
    }
    return this.adapterPromise;
  }
}
