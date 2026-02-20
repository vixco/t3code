import type { SqliteDatabase } from "../sqliteAdapter";
import { runStateMigrations } from "../stateMigrations";

export function runPersistenceMigrations(db: SqliteDatabase): void {
  runStateMigrations(db);
}
