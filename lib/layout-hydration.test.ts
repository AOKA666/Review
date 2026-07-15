import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const layoutPath = new URL("../app/layout.tsx", import.meta.url);

test("root layout tolerates browser extensions adding attributes before hydration", async () => {
  const source = await readFile(layoutPath, "utf8");

  assert.match(source, /<html\s+lang="zh-CN"\s+suppressHydrationWarning>/);
});
