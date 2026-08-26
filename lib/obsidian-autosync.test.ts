import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("../app/page.tsx", import.meta.url);

test("autosave does not wake Obsidian or external file watchers", async () => {
  const source = await readFile(pagePath, "utf8");
  const persistNow = source.match(/const persistNow = async \(\) => \{([\s\S]*?)\n  \};\n\n  const scheduleSave/)?.[1];

  assert.ok(persistNow, "persistNow function should exist");
  assert.doesNotMatch(persistNow, /syncCurrentReviewToObsidian/);
});

test("all Obsidian autosync failures are handled without opening the development error overlay", async () => {
  const source = await readFile(pagePath, "utf8");
  const syncHandler = source.match(/const syncCurrentReviewToObsidian = async \(payload: ReviewRecord\[\]\) => \{([\s\S]*?)\n  \};\n\n  const handleObsidianConnect/)?.[1];

  assert.ok(syncHandler, "syncCurrentReviewToObsidian function should exist");
  assert.ok(
    syncHandler.indexOf("try {") < syncHandler.indexOf("await hasWritePermission(handle)"),
    "permission checks must be inside the handled sync operation"
  );
  assert.doesNotMatch(syncHandler, /console\.(?:error|warn)/);
  assert.match(syncHandler, /setObsidianStatus\("error"\)/);
});

test("restoring a stale Obsidian folder does not log an overlay-triggering console error", async () => {
  const source = await readFile(pagePath, "utf8");
  const restoreEffect = source.match(/void loadDirectoryHandle\(\)\.then\([\s\S]*?\n  \}, \[\]\);/)?.[0];

  assert.ok(restoreEffect, "Obsidian restore effect should exist");
  assert.doesNotMatch(restoreEffect, /console\.(?:error|warn)/);
  assert.match(restoreEffect, /setObsidianStatus\("error"\)/);
});

test("Obsidian sync remains available as an explicit user action", async () => {
  const source = await readFile(pagePath, "utf8");
  const connectHandler = source.match(/const handleObsidianConnect = async \(\) => \{([\s\S]*?)\n  \};/)?.[1];

  assert.ok(connectHandler, "handleObsidianConnect function should exist");
  assert.match(connectHandler, /await syncCurrentReviewToObsidian\(latestReviews\.current\)/);
  assert.doesNotMatch(connectHandler, /console\.(?:error|warn)/);
});

test("an authorized Obsidian folder can be explicitly replaced", async () => {
  const source = await readFile(pagePath, "utf8");
  const changeHandler = source.match(/const handleObsidianFolderChange = async \(\) => \{([\s\S]*?)\n  \};/)?.[1];

  assert.ok(changeHandler, "handleObsidianFolderChange function should exist");
  assert.match(changeHandler, /authorizeObsidianDirectory\(null,/);
  assert.match(changeHandler, /obsidianDirectoryRef\.current = handle/);
  assert.match(source, /onClick=\{\(\) => void handleObsidianFolderChange\(\)\}/);
  assert.match(source, /\{t\.changeObsidianFolder\}/);
  assert.doesNotMatch(changeHandler, /console\.(?:error|warn)/);
});
