import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("../app/page.tsx", import.meta.url);

test("autosave continues syncing the current review to Obsidian", async () => {
  const source = await readFile(pagePath, "utf8");
  const persistNow = source.match(/const persistNow = async \(\) => \{([\s\S]*?)\n  \};\n\n  const scheduleSave/)?.[1];

  assert.ok(persistNow, "persistNow function should exist");
  assert.match(persistNow, /void syncCurrentReviewToObsidian\(payload\)/);
});

test("handled Obsidian sync failures do not trigger the development error overlay", async () => {
  const source = await readFile(pagePath, "utf8");
  const syncHandler = source.match(/const syncCurrentReviewToObsidian = async \(payload: ReviewRecord\[\]\) => \{([\s\S]*?)\n  \};\n\n  const handleObsidianConnect/)?.[1];

  assert.ok(syncHandler, "syncCurrentReviewToObsidian function should exist");
  assert.doesNotMatch(syncHandler, /console\.error/);
  assert.match(syncHandler, /console\.warn\("Obsidian sync failed", error\)/);
  assert.match(syncHandler, /setObsidianStatus\("error"\)/);
});

test("Obsidian sync remains available as an explicit user action", async () => {
  const source = await readFile(pagePath, "utf8");
  const connectHandler = source.match(/const handleObsidianConnect = async \(\) => \{([\s\S]*?)\n  \};\n\n  const persistNow/)?.[1];

  assert.ok(connectHandler, "handleObsidianConnect function should exist");
  assert.match(connectHandler, /await syncCurrentReviewToObsidian\(latestReviews\.current\)/);
});
