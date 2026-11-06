import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIdInFilterValue,
  buildJournalDateInFilterValue,
  journalDateNotInFilter,
  PostgrestFilterError
} from "./postgrest-filter.ts";

test("builds a parenthesized date IN list and rejects the unparenthesized PGRST100 form", () => {
  const value = buildJournalDateInFilterValue(["2026-11-06", "2026-11-07", "2026-11-06"]);
  const filter = journalDateNotInFilter(["2026-11-06", "2026-11-07"]);

  assert.equal(value, "(2026-11-06,2026-11-07)");
  assert.equal(filter, "not.in.(2026-11-06,2026-11-07)");
  assert.notEqual(filter, "not.in.2026-11-06,2026-11-07");
});

test("rejects empty lists and dates that could change filter syntax", () => {
  for (const dates of [[], ["2026/11/06"], ["2026-11-06)"], ["2026-11-06,2026-11-07"], ["(2026-11-06)"]]) {
    assert.throws(() => buildJournalDateInFilterValue(dates), PostgrestFilterError);
  }
  assert.throws(() => buildIdInFilterValue([]), PostgrestFilterError);
  assert.throws(() => buildIdInFilterValue(["bad id"]), PostgrestFilterError);
  assert.equal(buildIdInFilterValue(["item-1", "item-1"]), "(item-1)");
});
