import type * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { EffectSqliteDatabaseAdapter, SqliteDatabase } from "../sqliteAdapter";

function isEffectSqliteDatabase(db: SqliteDatabase): db is EffectSqliteDatabaseAdapter {
  return "runWithSqlClient" in db && typeof db.runWithSqlClient === "function";
}

export function runWithSqlClient<A>(
  db: SqliteDatabase,
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  fallback: () => A,
): A {
  if (isEffectSqliteDatabase(db)) {
    return db.runWithSqlClient(effect);
  }
  return fallback();
}
