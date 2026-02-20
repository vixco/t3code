import path from "node:path";

export interface PersistenceConfig {
  dbPath: string;
  legacyProjectsJsonPath?: string;
}

export function resolvePersistenceConfig(input: PersistenceConfig): PersistenceConfig {
  const resolved: PersistenceConfig = {
    dbPath: path.resolve(input.dbPath),
  };
  if (input.legacyProjectsJsonPath) {
    resolved.legacyProjectsJsonPath = path.resolve(input.legacyProjectsJsonPath);
  }
  return resolved;
}
