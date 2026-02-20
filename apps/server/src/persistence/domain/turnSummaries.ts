import { parsePatchFiles } from "@pierre/diffs";
import type { StateTurnDiffFileChange } from "@t3tools/contracts";

function parsePathFromDiff(diff: string): string | null {
  const normalized = diff.replace(/\r\n/g, "\n");
  const bPath = normalized.match(/^\+\+\+ b\/(.+)$/m);
  if (bPath?.[1]) return bPath[1];
  const gitHeader = normalized.match(/^diff --git a\/(.+) b\/\1$/m);
  if (gitHeader?.[1]) return gitHeader[1];
  const direct = normalized.match(/^\+\+\+ (.+)$/m);
  if (!direct?.[1] || direct[1] === "/dev/null") {
    return null;
  }
  return direct[1];
}

function splitUnifiedDiffByFile(diff: string): Map<string, string> {
  const normalized = diff.replace(/\r\n/g, "\n");
  const byPath = new Map<string, string>();
  const headerMatches = [...normalized.matchAll(/^diff --git .+$/gm)];

  if (headerMatches.length === 0) {
    const pathFromDiff = parsePathFromDiff(normalized);
    if (pathFromDiff) {
      byPath.set(pathFromDiff, normalized.trim());
    }
    return byPath;
  }

  for (let index = 0; index < headerMatches.length; index += 1) {
    const match = headerMatches[index];
    if (!match) continue;
    const start = match.index ?? 0;
    const end = headerMatches[index + 1]?.index ?? normalized.length;
    const segment = normalized.slice(start, end).trim();
    const pathFromDiff = parsePathFromDiff(segment);
    if (!pathFromDiff || segment.length === 0) continue;
    byPath.set(pathFromDiff, segment);
  }

  return byPath;
}

function countDiffStat(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

export function summarizeUnifiedDiff(diff: string): StateTurnDiffFileChange[] {
  try {
    const parsedPatches = parsePatchFiles(diff, "state-turn-summary", false);
    const files: StateTurnDiffFileChange[] = [];
    for (const patch of parsedPatches) {
      for (const file of patch.files) {
        const additions = file.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0);
        const deletions = file.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0);
        files.push({
          path: file.name,
          kind: file.type,
          additions,
          deletions,
        });
      }
    }
    if (files.length > 0) {
      return files.toSorted((a, b) => a.path.localeCompare(b.path));
    }
  } catch {
    // Fallback below.
  }

  const fileDiffsByPath = splitUnifiedDiffByFile(diff);
  const fallback: StateTurnDiffFileChange[] = [];
  for (const [filePath, fileDiff] of fileDiffsByPath) {
    const stat = countDiffStat(fileDiff);
    fallback.push({
      path: filePath,
      additions: stat.additions,
      deletions: stat.deletions,
    });
  }
  return fallback.toSorted((a, b) => a.path.localeCompare(b.path));
}

export function mergeTurnSummaryFiles(
  existing: StateTurnDiffFileChange[],
  incoming: StateTurnDiffFileChange[],
): StateTurnDiffFileChange[] {
  const byPath = new Map(existing.map((file) => [file.path, { ...file }] as const));
  for (const file of incoming) {
    const previous = byPath.get(file.path);
    if (!previous) {
      byPath.set(file.path, { ...file });
      continue;
    }
    byPath.set(file.path, {
      ...previous,
      ...(file.kind !== undefined ? { kind: file.kind } : {}),
      ...(file.additions !== undefined ? { additions: file.additions } : {}),
      ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
    });
  }
  return Array.from(byPath.values()).toSorted((a, b) => a.path.localeCompare(b.path));
}
