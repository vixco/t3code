import fs from "node:fs";
import path from "node:path";

export function normalizeCwd(rawCwd: string): string {
  const resolved = path.resolve(rawCwd.trim());
  const normalized = path.normalize(resolved);
  if (process.platform === "win32") {
    return normalized.toLowerCase();
  }
  return normalized;
}

export function isDirectory(cwd: string): boolean {
  try {
    return fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

export function inferProjectName(cwd: string): string {
  const name = path.basename(cwd);
  return name.length > 0 ? name : "project";
}
