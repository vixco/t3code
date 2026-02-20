import fs from "node:fs";
import path from "node:path";

import { openSqliteDatabase, type SqliteDatabase } from "../sqliteAdapter";

export function openPersistenceSqliteDatabase(dbPath: string): SqliteDatabase {
  const resolvedPath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  return openSqliteDatabase(resolvedPath);
}
