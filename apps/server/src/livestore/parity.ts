import type { StateBootstrapResult } from "@t3tools/contracts";

export interface SnapshotParityDiff {
  path: string;
  expected: unknown;
  actual: unknown;
}

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeSnapshot(snapshot: StateBootstrapResult): StateBootstrapResult {
  return {
    ...snapshot,
    projects: sortById(snapshot.projects),
    threads: sortById(snapshot.threads).map((thread) => ({
      ...thread,
      messages: [...thread.messages].sort((a, b) => {
        if (a.id === b.id) {
          return a.createdAt.localeCompare(b.createdAt);
        }
        return a.id.localeCompare(b.id);
      }),
      turnDiffSummaries: [...thread.turnDiffSummaries].sort((a, b) =>
        a.turnId.localeCompare(b.turnId),
      ),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectDiffs(
  expected: unknown,
  actual: unknown,
  path: string,
  diffs: SnapshotParityDiff[],
): void {
  if (Object.is(expected, actual)) {
    return;
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      diffs.push({ path, expected, actual });
      return;
    }
    if (expected.length !== actual.length) {
      diffs.push({
        path: `${path}.length`,
        expected: expected.length,
        actual: actual.length,
      });
      return;
    }
    for (let index = 0; index < expected.length; index += 1) {
      collectDiffs(expected[index], actual[index], `${path}[${index}]`, diffs);
    }
    return;
  }

  if (isRecord(expected) || isRecord(actual)) {
    if (!isRecord(expected) || !isRecord(actual)) {
      diffs.push({ path, expected, actual });
      return;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
      collectDiffs(expected[key], actual[key], `${path}.${key}`, diffs);
    }
    return;
  }

  diffs.push({ path, expected, actual });
}

export function diffStateSnapshots(
  expectedSnapshot: StateBootstrapResult,
  actualSnapshot: StateBootstrapResult,
): SnapshotParityDiff[] {
  const expected = normalizeSnapshot(expectedSnapshot);
  const actual = normalizeSnapshot(actualSnapshot);
  const diffs: SnapshotParityDiff[] = [];
  collectDiffs(expected, actual, "$", diffs);
  return diffs;
}

export function isStateSnapshotInParity(
  expectedSnapshot: StateBootstrapResult,
  actualSnapshot: StateBootstrapResult,
): boolean {
  return diffStateSnapshots(expectedSnapshot, actualSnapshot).length === 0;
}
