import type {
  StateBootstrapResult,
  StateCatchUpResult,
  StateListMessagesResult,
} from "@t3tools/contracts";

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

export function diffCatchUpResults(expected: StateCatchUpResult, actual: StateCatchUpResult): string[] {
  const diffs: string[] = [];

  if (expected.lastStateSeq !== actual.lastStateSeq) {
    diffs.push(
      `lastStateSeq mismatch: expected=${expected.lastStateSeq} actual=${actual.lastStateSeq}`,
    );
  }

  if (expected.events.length !== actual.events.length) {
    diffs.push(`events.length mismatch: expected=${expected.events.length} actual=${actual.events.length}`);
  }

  const minLength = Math.min(expected.events.length, actual.events.length);
  for (let index = 0; index < minLength; index += 1) {
    const expectedEvent = expected.events[index];
    const actualEvent = actual.events[index];
    if (!expectedEvent || !actualEvent) {
      continue;
    }
    if (expectedEvent.seq !== actualEvent.seq) {
      diffs.push(`events[${index}].seq mismatch: expected=${expectedEvent.seq} actual=${actualEvent.seq}`);
    }
    if (expectedEvent.eventType !== actualEvent.eventType) {
      diffs.push(
        `events[${index}].eventType mismatch: expected=${expectedEvent.eventType} actual=${actualEvent.eventType}`,
      );
    }
    if (expectedEvent.entityId !== actualEvent.entityId) {
      diffs.push(
        `events[${index}].entityId mismatch: expected=${expectedEvent.entityId} actual=${actualEvent.entityId}`,
      );
    }
    const expectedPayload = JSON.stringify(expectedEvent.payload);
    const actualPayload = JSON.stringify(actualEvent.payload);
    if (expectedPayload !== actualPayload) {
      diffs.push(`events[${index}].payload mismatch`);
    }
  }

  return diffs;
}

export function diffListMessagesResults(
  expected: StateListMessagesResult,
  actual: StateListMessagesResult,
): string[] {
  const diffs: string[] = [];

  if (expected.total !== actual.total) {
    diffs.push(`total mismatch: expected=${expected.total} actual=${actual.total}`);
  }
  if (expected.nextOffset !== actual.nextOffset) {
    diffs.push(
      `nextOffset mismatch: expected=${String(expected.nextOffset)} actual=${String(actual.nextOffset)}`,
    );
  }
  if (expected.messages.length !== actual.messages.length) {
    diffs.push(
      `messages.length mismatch: expected=${expected.messages.length} actual=${actual.messages.length}`,
    );
  }

  const minLength = Math.min(expected.messages.length, actual.messages.length);
  for (let index = 0; index < minLength; index += 1) {
    const expectedMessage = expected.messages[index];
    const actualMessage = actual.messages[index];
    if (!expectedMessage || !actualMessage) {
      continue;
    }
    const expectedSerialized = JSON.stringify(expectedMessage);
    const actualSerialized = JSON.stringify(actualMessage);
    if (expectedSerialized !== actualSerialized) {
      diffs.push(`messages[${index}] mismatch`);
    }
  }

  return diffs;
}
