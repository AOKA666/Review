import assert from "node:assert/strict";
import test from "node:test";

import { cloudSyncHints, cloudSyncStatusLabels } from "./cloud-sync-status.ts";

test("Chinese and English cloud status labels describe the same states", () => {
  assert.deepEqual(Object.keys(cloudSyncStatusLabels.zh), Object.keys(cloudSyncStatusLabels.en));
  assert.equal(cloudSyncStatusLabels.zh.pending.includes("本地"), true);
  assert.equal(cloudSyncStatusLabels.zh.pending.includes("同步"), true);
  assert.equal(cloudSyncStatusLabels.zh.syncing, "正在同步");
  assert.equal(cloudSyncStatusLabels.zh.synced.includes("云端"), true);
  assert.match(cloudSyncStatusLabels.zh.error, /重试/);
  assert.match(cloudSyncStatusLabels.en.pending, /pending sync/i);
  assert.equal(cloudSyncStatusLabels.en.syncing, "Syncing");
  assert.match(cloudSyncStatusLabels.en.synced, /cloud/i);
  assert.match(cloudSyncStatusLabels.en.error, /retry/i);
  assert.notEqual(cloudSyncStatusLabels.zh.pending, cloudSyncStatusLabels.zh.synced);
  assert.notEqual(cloudSyncStatusLabels.en.pending, cloudSyncStatusLabels.en.synced);
  assert.notEqual(cloudSyncHints.zh, cloudSyncHints.en);
});
