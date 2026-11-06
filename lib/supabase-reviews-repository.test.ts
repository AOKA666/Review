import assert from "node:assert/strict";
import test from "node:test";

import { ReviewsDbError } from "./reviews-service.ts";
import { ReviewsQueryBuilder, SupabaseReviewsRepository } from "./supabase-reviews-repository.ts";

const spyClient = (result: { data: unknown; error: { message?: string; code?: string } | null }) => {
  const calls: unknown[][] = [];
  const builder = {
    select: (...args: unknown[]) => { calls.push(["select", ...args]); return builder; },
    insert: (...args: unknown[]) => { calls.push(["insert", ...args]); return builder; },
    upsert: (...args: unknown[]) => { calls.push(["upsert", ...args]); return builder; },
    update: (...args: unknown[]) => { calls.push(["update", ...args]); return builder; },
    delete: (...args: unknown[]) => { calls.push(["delete", ...args]); return builder; },
    eq: (...args: unknown[]) => { calls.push(["eq", ...args]); return builder; },
    order: (...args: unknown[]) => { calls.push(["order", ...args]); return builder; },
    filter: (...args: unknown[]) => { calls.push(["filter", ...args]); return builder; },
    not: (...args: unknown[]) => { calls.push(["not", ...args]); return builder; },
    single: () => Promise.resolve(result),
    then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject)
  };
  return {
    calls,
    client: {
      from: (table: string) => {
        calls.push(["from", table]);
        return builder as unknown as ReviewsQueryBuilder;
      }
    }
  };
};

test("journal date lookups use a parenthesized IN list", async () => {
  const spy = spyClient({ data: [], error: null });
  const repo = new SupabaseReviewsRepository(spy.client);

  await repo.findJournalsByDates("default", ["2026-11-06", "2026-11-07"]);

  assert.deepEqual(
    spy.calls.find((call) => call[0] === "filter"),
    ["filter", "journal_date", "in", "(2026-11-06,2026-11-07)"]
  );
  assert.equal(spy.calls.some((call) => call[0] === "not" && call[1] === "journal_date"), false);
});

test("empty child reads do not send an empty IN filter", async () => {
  const spy = spyClient({ data: [], error: null });
  const repo = new SupabaseReviewsRepository(spy.client);

  assert.deepEqual(await repo.listItems([]), []);
  assert.deepEqual(await repo.listQas([]), []);
  assert.deepEqual(spy.calls, []);
  await assert.rejects(() => repo.findJournalsByDates("default", []), (error: unknown) =>
    error instanceof ReviewsDbError && error.stage === "journals_lookup"
  );
});

test("item deletes use a parenthesized id list and surface database errors", async () => {
  const success = spyClient({ data: [], error: null });
  await new SupabaseReviewsRepository(success.client).deleteItemsExcept("journal-1", ["item-1", "item-2"]);
  assert.deepEqual(
    success.calls.find((call) => call[0] === "not"),
    ["not", "id", "in", "(item-1,item-2)"]
  );

  const emptyKeep = spyClient({ data: [], error: null });
  await new SupabaseReviewsRepository(emptyKeep.client).deleteItemsExcept("journal-1", []);
  assert.equal(emptyKeep.calls.some((call) => call[0] === "not"), false);

  const failure = spyClient({ data: null, error: { message: "delete failed", code: "XX000" } });
  await assert.rejects(
    () => new SupabaseReviewsRepository(failure.client).deleteItemsExcept("journal-1", ["item-1"]),
    (error: unknown) => error instanceof ReviewsDbError && error.stage === "items_delete"
  );
});

test("item upserts clear the soft-delete flag so hidden rows are readable again", async () => {
  const spy = spyClient({ data: null, error: null });
  await new SupabaseReviewsRepository(spy.client).upsertItems([{
    id: "item-1",
    journal_id: "journal-1",
    type: "red",
    content: "back",
    sort_order: 0
  }]);

  const payload = spy.calls.find((call) => call[0] === "upsert")?.[1] as Array<{ is_deleted?: boolean }>;
  assert.equal(payload[0]?.is_deleted, false);
});
