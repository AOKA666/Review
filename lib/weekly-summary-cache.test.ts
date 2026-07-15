import assert from "node:assert/strict";
import test from "node:test";

import { shouldGenerateWeeklySummary, weeklySummaryKey } from "./weekly-summary-cache.ts";

test("uses a language-specific persistent key", () => {
  assert.equal(weeklySummaryKey("2026-07-12", "zh"), "2026-07-12:zh");
  assert.equal(weeklySummaryKey("2026-07-12", "en"), "2026-07-12:en");
});

test("does not regenerate a saved weekly summary unless explicitly requested", () => {
  assert.equal(shouldGenerateWeeklySummary({ status: "ready", summary: "saved" }, false), false);
  assert.equal(shouldGenerateWeeklySummary({ status: "ready", summary: "saved" }, true), true);
  assert.equal(shouldGenerateWeeklySummary(undefined, false), true);
});
