import type { StateThread } from "@t3tools/contracts";

const MAX_TERMINAL_COUNT = 4;
const DEFAULT_TERMINAL_ID = "default";

export function normalizeTerminalIds(ids: readonly string[]): string[] {
  const normalized = [
    ...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)),
  ].slice(0, MAX_TERMINAL_COUNT);
  if (normalized.length > 0) {
    return normalized;
  }
  return [DEFAULT_TERMINAL_ID];
}

function normalizeRunningTerminalIds(
  runningTerminalIds: readonly string[],
  terminalIds: readonly string[],
): string[] {
  if (runningTerminalIds.length === 0) {
    return [];
  }

  const validTerminalIds = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIds.has(id))
    .slice(0, MAX_TERMINAL_COUNT);
}

export function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(groupId: string, usedGroupIds: Set<string>): string {
  if (!usedGroupIds.has(groupId)) {
    usedGroupIds.add(groupId);
    return groupId;
  }

  let suffix = 2;
  while (usedGroupIds.has(`${groupId}-${suffix}`)) {
    suffix += 1;
  }
  const uniqueGroupId = `${groupId}-${suffix}`;
  usedGroupIds.add(uniqueGroupId);
  return uniqueGroupId;
}

function normalizeTerminalGroups(
  groups: StateThread["terminalGroups"],
  terminalIds: readonly string[],
): StateThread["terminalGroups"] {
  const validTerminalIds = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const usedGroupIds = new Set<string>();
  const normalizedGroups: StateThread["terminalGroups"] = [];

  for (const group of groups) {
    const groupTerminalIds = [
      ...new Set(group.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
    ].filter((terminalId) => {
      if (!validTerminalIds.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? DEFAULT_TERMINAL_ID);
    normalizedGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    normalizedGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (normalizedGroups.length > 0) {
    return normalizedGroups;
  }

  return [{ id: fallbackGroupId(DEFAULT_TERMINAL_ID), terminalIds: [DEFAULT_TERMINAL_ID] }];
}

export function normalizeThread(thread: StateThread): StateThread {
  const terminalIds = normalizeTerminalIds(thread.terminalIds);
  const runningTerminalIds = normalizeRunningTerminalIds(thread.runningTerminalIds, terminalIds);
  const activeTerminalId = terminalIds.includes(thread.activeTerminalId)
    ? thread.activeTerminalId
    : (terminalIds[0] ?? DEFAULT_TERMINAL_ID);
  const terminalGroups = normalizeTerminalGroups(thread.terminalGroups, terminalIds);
  const activeGroupId =
    terminalGroups.find((group) => group.id === thread.activeTerminalGroupId)?.id ??
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(activeTerminalId);

  return {
    ...thread,
    terminalIds,
    runningTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId: activeGroupId,
  };
}
