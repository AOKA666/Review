import assert from "node:assert/strict";
import test from "node:test";

import { reconcileCollapsedMonths, reconcileMonthCollapseState } from "./history-months.ts";

test("collapses historical months that arrive after the initial local hydration", () => {
  const first = reconcileCollapsedMonths({
    monthKeys: ["2026-07"],
    currentMonth: "2026-07",
    collapsedMonths: new Set<string>(),
    knownMonths: new Set<string>()
  });

  assert.deepEqual([...first.collapsedMonths], []);

  const afterRemoteSync = reconcileCollapsedMonths({
    monthKeys: ["2026-07", "2026-06", "2026-05"],
    currentMonth: "2026-07",
    collapsedMonths: first.collapsedMonths,
    knownMonths: first.knownMonths
  });

  assert.deepEqual([...afterRemoteSync.collapsedMonths].sort(), ["2026-05", "2026-06"]);
});

test("does not collapse a historical month again after the user expands it", () => {
  const result = reconcileCollapsedMonths({
    monthKeys: ["2026-07", "2026-06"],
    currentMonth: "2026-07",
    collapsedMonths: new Set<string>(),
    knownMonths: new Set(["2026-07", "2026-06"])
  });

  assert.deepEqual([...result.collapsedMonths], []);
});

test("keeps month reconciliation deterministic when React replays a state updater", () => {
  const previous = {
    collapsedMonths: new Set<string>(),
    knownMonths: new Set<string>()
  };
  const input = {
    monthKeys: ["2026-07", "2026-06", "2026-05"],
    currentMonth: "2026-07",
    state: previous
  };

  const first = reconcileMonthCollapseState(input);
  const replay = reconcileMonthCollapseState(input);

  assert.deepEqual([...first.collapsedMonths].sort(), ["2026-05", "2026-06"]);
  assert.deepEqual([...replay.collapsedMonths].sort(), ["2026-05", "2026-06"]);
  assert.deepEqual([...previous.knownMonths], []);
});
