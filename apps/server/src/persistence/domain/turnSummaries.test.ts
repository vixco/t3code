import { describe, expect, test } from "vitest";

import { mergeTurnSummaryFiles, summarizeUnifiedDiff } from "./turnSummaries";

describe("turnSummaries domain helpers", () => {
  test("summarizeUnifiedDiff returns per-file diff stats", () => {
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,2 +1,3 @@",
      " line1",
      "-line2",
      "+line2-updated",
      "+line3",
      "",
    ].join("\n");

    expect(summarizeUnifiedDiff(diff)).toEqual([
      {
        path: "src/example.ts",
        kind: "change",
        additions: 2,
        deletions: 1,
      },
    ]);
  });

  test("mergeTurnSummaryFiles merges by path while preserving prior fields", () => {
    const existing = [
      { path: "a.ts", kind: "modified" as const, additions: 1, deletions: 2 },
      { path: "b.ts", kind: "deleted" as const, additions: 0, deletions: 4 },
    ];
    const incoming = [
      { path: "a.ts", additions: 3, deletions: 5 },
      { path: "c.ts", kind: "added" as const, additions: 7, deletions: 0 },
    ];

    expect(mergeTurnSummaryFiles(existing, incoming)).toEqual([
      { path: "a.ts", kind: "modified", additions: 3, deletions: 5 },
      { path: "b.ts", kind: "deleted", additions: 0, deletions: 4 },
      { path: "c.ts", kind: "added", additions: 7, deletions: 0 },
    ]);
  });
});
