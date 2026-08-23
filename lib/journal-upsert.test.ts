import assert from "node:assert/strict";
import test from "node:test";

import { buildJournalUpsertRows } from "./journal-upsert.ts";

test("reuses the database journal id when the same date already exists", () => {
  const rows = buildJournalUpsertRows({
    owner: "default",
    reviews: [
      {
        id: "local-id",
        date: "2026-08-22",
        created_at: "2026-08-22T01:00:00.000Z",
        updated_at: "2026-08-22T02:00:00.000Z"
      }
    ],
    existing: [{ id: "database-id", journal_date: "2026-08-22" }]
  });

  assert.deepEqual(rows, [
    {
      id: "database-id",
      owner: "default",
      journal_date: "2026-08-22",
      created_at: "2026-08-22T01:00:00.000Z",
      updated_at: "2026-08-22T02:00:00.000Z"
    }
  ]);
});

test("keeps the local id for a date that does not exist in the database", () => {
  const rows = buildJournalUpsertRows({
    owner: "default",
    reviews: [
      {
        id: "new-local-id",
        date: "2026-08-23",
        created_at: "2026-08-23T01:00:00.000Z",
        updated_at: "2026-08-23T02:00:00.000Z"
      }
    ],
    existing: []
  });

  assert.equal(rows[0]?.id, "new-local-id");
});
