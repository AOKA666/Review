import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ReviewRecord } from "./review.ts";
import {
  ItemRow,
  JournalRow,
  QaRow,
  ReviewsDbError,
  ReviewsRepository,
  readReviews,
  saveReviews
} from "./reviews-service.ts";

const owner = "default";

class MemoryReviewsRepository implements ReviewsRepository {
  journals: JournalRow[] = [];
  items: ItemRow[] = [];
  qas: QaRow[] = [];
  calls: string[] = [];
  failOn: string | null = null;
  private stamp = Date.parse("2026-11-06T00:00:00.000Z");

  private tick() {
    this.stamp += 1000;
    return new Date(this.stamp).toISOString();
  }

  private guard(stage: string) {
    this.calls.push(stage);
    if (this.failOn === stage) throw new ReviewsDbError(stage, { message: "forced" });
  }

  async listJournals(ownerKey: string) {
    this.guard("listJournals");
    return this.journals.filter((journal) => journal.owner === ownerKey);
  }

  async listItems(journalIds: string[]) {
    this.guard("listItems");
    if (journalIds.length === 0) return [];
    const ids = new Set(journalIds);
    return this.items.filter((item) => ids.has(item.journal_id));
  }

  async listQas(itemIds: string[]) {
    this.guard("listQas");
    if (itemIds.length === 0) return [];
    const ids = new Set(itemIds);
    return this.qas.filter((qa) => ids.has(qa.item_id));
  }

  async findJournalsByDates(ownerKey: string, dates: string[]) {
    this.guard("findJournalsByDates");
    const wanted = new Set(dates);
    return this.journals.filter((journal) => journal.owner === ownerKey && wanted.has(journal.journal_date));
  }

  async insertJournal(row: { id: string; owner: string; journal_date: string; created_at: string }) {
    this.guard("insertJournal");
    if (this.journals.some((journal) => journal.id === row.id || (journal.owner === row.owner && journal.journal_date === row.journal_date))) {
      return "conflict" as const;
    }
    const journal = { ...row, updated_at: this.tick() };
    this.journals.push(journal);
    return journal;
  }

  async claimJournal(id: string, ownerKey: string, baseUpdatedAt: string) {
    this.guard("claimJournal");
    const journal = this.journals.find((item) => item.id === id && item.owner === ownerKey);
    if (!journal || journal.updated_at !== baseUpdatedAt) return "conflict" as const;
    journal.updated_at = this.tick();
    return { ...journal };
  }

  async upsertItems(rows: ItemRow[]) {
    this.guard("items_upsert");
    for (const row of rows) {
      const index = this.items.findIndex((item) => item.id === row.id);
      if (index >= 0) this.items[index] = row;
      else this.items.push(row);
    }
  }

  async deleteItemsExcept(journalId: string, keepIds: string[]) {
    this.guard("items_delete");
    const keep = new Set(keepIds);
    const removed = new Set(this.items.filter((item) => item.journal_id === journalId && !keep.has(item.id)).map((item) => item.id));
    this.items = this.items.filter((item) => !removed.has(item.id));
    this.qas = this.qas.filter((qa) => !removed.has(qa.item_id));
  }

  async upsertQas(rows: QaRow[]) {
    this.guard("upsertQas");
    for (const row of rows) {
      const index = this.qas.findIndex((qa) => qa.id === row.id);
      if (index >= 0) this.qas[index] = row;
      else this.qas.push(row);
    }
  }

  async deleteQasExcept(itemIds: string[], keepIds: string[]) {
    this.guard("qas_delete");
    const items = new Set(itemIds);
    const keep = new Set(keepIds);
    this.qas = this.qas.filter((qa) => !items.has(qa.item_id) || keep.has(qa.id));
  }

  async deleteJournal(id: string, ownerKey: string, baseUpdatedAt: string) {
    this.guard("journals_delete");
    const journal = this.journals.find((item) => item.id === id && item.owner === ownerKey);
    if (!journal || journal.updated_at !== baseUpdatedAt) return "conflict" as const;
    const removedItems = new Set(this.items.filter((item) => item.journal_id === id).map((item) => item.id));
    this.journals = this.journals.filter((item) => item.id !== id);
    this.items = this.items.filter((item) => item.journal_id !== id);
    this.qas = this.qas.filter((qa) => !removedItems.has(qa.item_id));
    return "deleted" as const;
  }
}

const review = (day: string, text: string, extra = ""): ReviewRecord => ({
  id: `local-${day}`,
  date: day,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  today_log: {
    red: [{
      id: `red-${day}`,
      text,
      order_index: 0,
      reflection_qas: extra
        ? [{ id: `qa-${day}`, question: "why", answer: extra, showAnswer: true, order_index: 0 }]
        : []
    }],
    black: []
  }
});

const seed = (repo: MemoryReviewsRepository, day: string, text: string, updatedAt: string) => {
  repo.journals.push({
    id: `db-${day}`,
    owner,
    journal_date: day,
    created_at: updatedAt,
    updated_at: updatedAt
  });
  repo.items.push({
    id: `red-${day}`,
    journal_id: `db-${day}`,
    type: "red",
    content: text,
    sort_order: 0
  });
};

test("an empty save does not delete remote journals", async () => {
  const repo = new MemoryReviewsRepository();
  seed(repo, "2026-11-06", "keep", "t0");

  const result = await saveReviews(repo, owner, { reviews: [] });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(repo.journals.length, 1);
  assert.equal(repo.calls.length, 0);
});

test("saving one date does not overwrite or delete another device's date", async () => {
  const repo = new MemoryReviewsRepository();
  seed(repo, "2026-11-05", "home", "t-home");
  seed(repo, "2026-11-06", "old", "t-office");

  const result = await saveReviews(repo, owner, {
    reviews: [review("2026-11-06", "office edit", "because")],
    deletedDates: [],
    baseUpdatedAt: { "2026-11-06": "t-office" }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  const read = await readReviews(repo, owner);
  assert.equal(read.status, 200);
  if (read.status !== 200) return;
  const home = read.body.reviews.find((item) => item.date === "2026-11-05");
  const office = read.body.reviews.find((item) => item.date === "2026-11-06");
  assert.equal(home?.today_log.red[0]?.text, "home");
  assert.equal(office?.today_log.red[0]?.text, "office edit");
  assert.equal(office?.today_log.red[0]?.reflection_qas[0]?.answer, "because");
  assert.equal(office?.id, "db-2026-11-06");
});

test("a stale base conflicts and leaves the stored text untouched", async () => {
  const repo = new MemoryReviewsRepository();
  seed(repo, "2026-11-06", "home edit", "t1");

  const result = await saveReviews(repo, owner, {
    reviews: [review("2026-11-06", "stale office")],
    baseUpdatedAt: { "2026-11-06": "t0" }
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.ok, false);
  if (!result.body.ok && result.body.error === "conflict" && "conflicts" in result.body) {
    assert.equal(result.body.conflicts[0]?.review.today_log.red[0]?.text, "home edit");
  }
  assert.equal(repo.items[0]?.content, "home edit");
});

test("database delete and upsert failures are not reported as success", async () => {
  for (const stage of ["items_delete", "qas_delete", "journals_delete", "items_upsert"]) {
    const repo = new MemoryReviewsRepository();
    seed(repo, "2026-11-06", "existing", "t0");
    repo.failOn = stage;
    const payload = stage === "journals_delete"
      ? { reviews: [], deletedDates: ["2026-11-06"], baseUpdatedAt: { "2026-11-06": "t0" } }
      : { reviews: [review("2026-11-06", "next")], baseUpdatedAt: { "2026-11-06": "t0" } };

    const result = await saveReviews(repo, owner, payload);

    assert.equal(result.status, 500, stage);
    assert.equal(result.body.ok, false, stage);
    if (!result.body.ok) assert.equal(result.body.error, stage);
    assert.equal(repo.journals.length, 1, stage);
  }
});

test("journals with no items or qas still load, and qas are not queried for an empty item list", async () => {
  const repo = new MemoryReviewsRepository();
  repo.journals.push({
    id: "empty-day",
    owner,
    journal_date: "2026-11-06",
    created_at: "t0",
    updated_at: "t0"
  });

  const result = await readReviews(repo, owner);

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.reviews.length, 1);
  assert.deepEqual(result.body.reviews[0]?.today_log, { red: [], black: [] });
  assert.equal(repo.calls.includes("listQas"), false);
});

test("explicit deletes remove only that date, and an unknown base cannot delete it", async () => {
  const repo = new MemoryReviewsRepository();
  seed(repo, "2026-11-05", "stay", "t-stay");
  seed(repo, "2026-11-06", "go", "t-go");

  const refused = await saveReviews(repo, owner, {
    reviews: [],
    deletedDates: ["2026-11-06"],
    baseUpdatedAt: { "2026-11-06": null }
  });
  assert.equal(refused.status, 409);
  assert.equal(repo.journals.length, 2);

  const removed = await saveReviews(repo, owner, {
    reviews: [],
    deletedDates: ["2026-11-06"],
    baseUpdatedAt: { "2026-11-06": "t-go" }
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(repo.journals.map((journal) => journal.journal_date), ["2026-11-05"]);
});

test("clearing a day's items does not touch another day, and a missing journal id fails the save", async () => {
  const repo = new MemoryReviewsRepository();
  seed(repo, "2026-11-05", "stay", "t-stay");
  seed(repo, "2026-11-06", "clear me", "t-clear");

  const cleared = await saveReviews(repo, owner, {
    reviews: [{ ...review("2026-11-06", ""), today_log: { red: [], black: [] } }],
    baseUpdatedAt: { "2026-11-06": "t-clear" }
  });
  assert.equal(cleared.status, 200);
  assert.equal(repo.items.some((item) => item.journal_id === "db-2026-11-06"), false);
  assert.equal(repo.items.some((item) => item.content === "stay"), true);

  const unmapped = new MemoryReviewsRepository();
  unmapped.insertJournal = async (row) => ({
    id: "",
    owner: row.owner,
    journal_date: row.journal_date,
    created_at: row.created_at,
    updated_at: "t"
  });
  const failed = await saveReviews(unmapped, owner, { reviews: [review("2026-11-07", "new")] });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.ok, false);
  if (!failed.body.ok) assert.equal(failed.body.error, "journal_unmapped");
});

test("invalid dates fail before any remote write", async () => {
  const repo = new MemoryReviewsRepository();
  seed(repo, "2026-11-06", "stay", "t0");

  const result = await saveReviews(repo, owner, {
    reviews: [review("2026-11-06)", "bad")],
    deletedDates: []
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.equal(repo.items[0]?.content, "stay");
  assert.equal(repo.calls.length, 0);
});

test("the route no longer ignores delete errors or builds a bare not.in date filter", async () => {
  const source = await readFile(new URL("../app/api/reviews/route.ts", import.meta.url), "utf8");
  assert.match(source, /saveReviews/);
  assert.doesNotMatch(source, /\.not\(\s*["']journal_date["']/);
  assert.doesNotMatch(source, /console\.error\([\s\S]{0,120}\bok:\s*true/);
});
