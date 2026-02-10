import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WRAPPER_FILES = [
  "processManager.ts",
  "todoStore.ts",
  "providerManager.ts",
  "codexAppServerManager.ts",
] as const;

describe("desktop runtime compatibility surface", () => {
  for (const fileName of WRAPPER_FILES) {
    it(`${fileName} re-exports from runtime-core`, () => {
      const filePath = path.resolve(import.meta.dirname, fileName);
      const source = fs.readFileSync(filePath, "utf8");

      expect(source).toContain("@acme/runtime-core");
      expect(source).toContain("export {");
      expect(source).not.toContain("class ");
    });
  }
});
