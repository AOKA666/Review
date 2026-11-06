import { buildJournalUpsertRows } from "./journal-upsert";
import { PostgrestFilterError, assertJournalDates } from "./postgrest-filter";
import { LogItem, QaPair, ReviewRecord } from "./review";
import { sortReviews } from "./review-content";

export class ReviewsDbError extends Error {
  readonly stage: string;

  constructor(stage: string, readonly cause?: unknown) {
    super(stage);
    this.name = "ReviewsDbError";
    this.stage = stage;
  }
}

export type JournalRow = {
  id: string;
  owner: string;
  journal_date: string;
  created_at: string;
  updated_at: string;
};

export type ItemRow = {
  id: string;
  journal_id: string;
  type: "red" | "black";
  content: string;
  sort_order: number;
};

export type QaRow = {
  id: string;
  item_id: string;
  question: string;
  answer: string;
  show_answer: boolean;
  order_index: number;
};

export interface ReviewsRepository {
  listJournals(owner: string): Promise<JournalRow[]>;
  listItems(journalIds: string[]): Promise<ItemRow[]>;
  listQas(itemIds: string[]): Promise<QaRow[]>;
  findJournalsByDates(owner: string, dates: string[]): Promise<JournalRow[]>;
  insertJournal(row: { id: string; owner: string; journal_date: string; created_at: string }): Promise<JournalRow | "conflict">;
  claimJournal(id: string, owner: string, baseUpdatedAt: string): Promise<JournalRow | "conflict">;
  upsertItems(rows: ItemRow[]): Promise<void>;
  deleteItemsExcept(journalId: string, keepIds: string[]): Promise<void>;
  upsertQas(rows: QaRow[]): Promise<void>;
  deleteQasExcept(itemIds: string[], keepIds: string[]): Promise<void>;
  deleteJournal(id: string, owner: string, baseUpdatedAt: string): Promise<"deleted" | "conflict">;
}

export type SaveSuccessBody = {
  ok: true;
  savedDates: string[];
  deletedDates: string[];
  updatedAtByDate: Record<string, string>;
};

export type SaveFailureBody = { ok: false; error: string };

export type SaveConflictBody = {
  ok: false;
  error: "conflict";
  conflicts: Array<{ date: string; review: ReviewRecord }>;
};

export type SaveResult = {
  status: number;
  body: SaveSuccessBody | SaveFailureBody | SaveConflictBody;
};

export type ReadResult =
  | { status: 200; body: { reviews: ReviewRecord[]; updated_at: string | null } }
  | { status: 500; stage: string; body: { reviews: []; updated_at: null } };

type PreparedItem = {
  id: string;
  type: "red" | "black";
  content: string;
  sort_order: number;
  qas: QaRow[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const failure = (status: number, error: string): SaveResult => ({
  status,
  body: { ok: false, error }
});

export const assembleReviews = (journals: JournalRow[], items: ItemRow[], qas: QaRow[]): ReviewRecord[] => {
  const qasByItem = new Map<string, QaRow[]>();
  for (const qa of qas) {
    const list = qasByItem.get(qa.item_id) ?? [];
    list.push(qa);
    qasByItem.set(qa.item_id, list);
  }
  for (const list of qasByItem.values()) list.sort((a, b) => a.order_index - b.order_index);

  const itemsByJournal = new Map<string, ItemRow[]>();
  for (const item of items) {
    const list = itemsByJournal.get(item.journal_id) ?? [];
    list.push(item);
    itemsByJournal.set(item.journal_id, list);
  }
  for (const list of itemsByJournal.values()) list.sort((a, b) => a.sort_order - b.sort_order);

  const reviews = journals.map((journal) => {
    const red: LogItem[] = [];
    const black: LogItem[] = [];
    for (const item of itemsByJournal.get(journal.id) ?? []) {
      const logItem: LogItem = {
        id: item.id,
        text: item.content,
        order_index: item.sort_order,
        reflection_qas: (qasByItem.get(item.id) ?? []).map((qa): QaPair => ({
          id: qa.id,
          question: qa.question,
          answer: qa.answer,
          showAnswer: qa.show_answer,
          order_index: qa.order_index
        }))
      };
      if (item.type === "red") red.push(logItem);
      else black.push(logItem);
    }
    return {
      id: journal.id,
      date: journal.journal_date,
      created_at: journal.created_at,
      updated_at: journal.updated_at,
      today_log: { red, black }
    };
  });
  return sortReviews(reviews);
};

const latestUpdatedAt = (journals: JournalRow[]) => {
  let latest: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const journal of journals) {
    const time = Date.parse(journal.updated_at);
    if (Number.isFinite(time) && time >= latestTime) {
      latestTime = time;
      latest = journal.updated_at;
    }
  }
  return latest;
};

const reviewsFor = async (repo: ReviewsRepository, journals: JournalRow[]) => {
  if (journals.length === 0) return [];
  const items = await repo.listItems(journals.map((journal) => journal.id));
  const qas = items.length ? await repo.listQas(items.map((item) => item.id)) : [];
  return assembleReviews(journals, items, qas);
};

export const readReviews = async (repo: ReviewsRepository, owner: string): Promise<ReadResult> => {
  try {
    const journals = await repo.listJournals(owner);
    const reviews = await reviewsFor(repo, journals);
    return { status: 200, body: { reviews, updated_at: latestUpdatedAt(journals) } };
  } catch (error) {
    const stage = error instanceof ReviewsDbError ? error.stage : "read_failed";
    return { status: 500, stage, body: { reviews: [], updated_at: null } };
  }
};

const coerceReview = (value: unknown): ReviewRecord | null => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.date !== "string") return null;
  const today = isRecord(value.today_log) ? value.today_log : {};
  return {
    id: value.id,
    date: value.date,
    created_at: typeof value.created_at === "string" ? value.created_at : "1970-01-01T00:00:00.000Z",
    updated_at: typeof value.updated_at === "string" ? value.updated_at : "1970-01-01T00:00:00.000Z",
    today_log: {
      red: Array.isArray(today.red) ? today.red as LogItem[] : [],
      black: Array.isArray(today.black) ? today.black as LogItem[] : []
    }
  };
};

const prepareItems = (review: ReviewRecord): { items: PreparedItem[] } | { error: string } => {
  const items: PreparedItem[] = [];
  const seenItems = new Set<string>();
  const seenQas = new Set<string>();
  for (const column of ["red", "black"] as const) {
    for (const item of review.today_log[column] ?? []) {
      if (!item || typeof item.id !== "string" || !item.id) return { error: "invalid_item" };
      if (seenItems.has(item.id)) return { error: "duplicate_item" };
      seenItems.add(item.id);
      const qas: QaRow[] = [];
      for (const qa of item.reflection_qas ?? []) {
        if (!qa || typeof qa.id !== "string" || !qa.id) return { error: "invalid_qa" };
        if (seenQas.has(qa.id)) return { error: "duplicate_qa" };
        seenQas.add(qa.id);
        qas.push({
          id: qa.id,
          item_id: item.id,
          question: typeof qa.question === "string" ? qa.question : "",
          answer: typeof qa.answer === "string" ? qa.answer : "",
          show_answer: Boolean(qa.showAnswer),
          order_index: typeof qa.order_index === "number" ? qa.order_index : 0
        });
      }
      items.push({
        id: item.id,
        type: column,
        content: typeof item.text === "string" ? item.text : "",
        sort_order: typeof item.order_index === "number" ? item.order_index : 0,
        qas
      });
    }
  }
  return { items };
};

type ParsedSave = {
  reviews: ReviewRecord[];
  deletedDates: string[];
  baseUpdatedAt: Record<string, string | null>;
  prepared: Map<string, PreparedItem[]>;
};

const parseSavePayload = (payload: unknown): ParsedSave | SaveResult => {
  if (!isRecord(payload) || !Array.isArray(payload.reviews)) return failure(400, "invalid_reviews");
  const reviews: ReviewRecord[] = [];
  for (const entry of payload.reviews) {
    const review = coerceReview(entry);
    if (!review) return failure(400, "invalid_review");
    reviews.push(review);
  }
  const deletedDates = Array.isArray(payload.deletedDates)
    ? payload.deletedDates.filter((date): date is string => typeof date === "string")
    : [];
  if (Array.isArray(payload.deletedDates) && deletedDates.length !== payload.deletedDates.length) {
    return failure(400, "invalid_deleted_dates");
  }

  let reviewDates: string[];
  let deleteDates: string[];
  try {
    reviewDates = assertJournalDates(reviews.map((review) => review.date));
    deleteDates = assertJournalDates(deletedDates);
  } catch (error) {
    if (error instanceof PostgrestFilterError) return failure(400, error.code);
    throw error;
  }
  if (reviewDates.length !== reviews.length) return failure(400, "duplicate_date");
  if (deleteDates.some((date) => reviewDates.includes(date))) return failure(400, "overlapping_date");

  const baseUpdatedAt: Record<string, string | null> = {};
  if (payload.baseUpdatedAt != null) {
    if (!isRecord(payload.baseUpdatedAt)) return failure(400, "invalid_base");
    for (const [date, value] of Object.entries(payload.baseUpdatedAt)) {
      if (typeof value === "string" || value === null) baseUpdatedAt[date] = value;
      else return failure(400, "invalid_base");
    }
  }

  const prepared = new Map<string, PreparedItem[]>();
  for (const review of reviews) {
    const content = prepareItems(review);
    if ("error" in content) return failure(400, content.error);
    prepared.set(review.date, content.items);
  }
  return { reviews, deletedDates: deleteDates, baseUpdatedAt, prepared };
};

const conflictResult = async (repo: ReviewsRepository, journals: JournalRow[]): Promise<SaveResult> => {
  const uniqueJournals = [...new Map(journals.map((journal) => [journal.id, journal])).values()];
  const reviews = await reviewsFor(repo, uniqueJournals);
  return {
    status: 409,
    body: {
      ok: false,
      error: "conflict",
      conflicts: reviews.map((review) => ({ date: review.date, review }))
    }
  };
};

const baseFor = (bases: Record<string, string | null>, date: string) =>
  Object.hasOwn(bases, date) ? bases[date] : null;

export const saveReviews = async (
  repo: ReviewsRepository,
  owner: string,
  payload: unknown
): Promise<SaveResult> => {
  const parsed = parseSavePayload(payload);
  if ("status" in parsed) return parsed;
  if (parsed.reviews.length === 0 && parsed.deletedDates.length === 0) {
    return { status: 200, body: { ok: true, savedDates: [], deletedDates: [], updatedAtByDate: {} } };
  }

  try {
    const dates = [...parsed.reviews.map((review) => review.date), ...parsed.deletedDates];
    const existing = await repo.findJournalsByDates(owner, dates);
    const byDate = new Map(existing.map((journal) => [journal.journal_date, journal]));
    const conflicts: JournalRow[] = [];
    const upserts: Array<{ review: ReviewRecord; existing: JournalRow | null }> = [];
    const deletions: Array<{ date: string; existing: JournalRow | null }> = [];

    for (const review of parsed.reviews) {
      const row = byDate.get(review.date) ?? null;
      const base = baseFor(parsed.baseUpdatedAt, review.date);
      if (row && row.updated_at !== base) conflicts.push(row);
      else upserts.push({ review, existing: row });
    }
    for (const date of parsed.deletedDates) {
      const row = byDate.get(date) ?? null;
      const base = baseFor(parsed.baseUpdatedAt, date);
      if (row && row.updated_at !== base) conflicts.push(row);
      else deletions.push({ date, existing: row });
    }
    if (conflicts.length > 0) return conflictResult(repo, conflicts);

    const idRows = buildJournalUpsertRows({
      owner,
      reviews: parsed.reviews,
      existing: existing.map((journal) => ({ id: journal.id, journal_date: journal.journal_date }))
    });
    const idByDate = new Map(idRows.map((row) => [row.journal_date, row.id]));
    const savedDates: string[] = [];
    const updatedAtByDate: Record<string, string> = {};

    for (const op of upserts) {
      const journalId = idByDate.get(op.review.date);
      if (!journalId) return failure(500, "journal_unmapped");
      const journal = op.existing
        ? await repo.claimJournal(op.existing.id, owner, op.existing.updated_at)
        : await repo.insertJournal({
          id: journalId,
          owner,
          journal_date: op.review.date,
          created_at: op.review.created_at
        });
      if (journal === "conflict") {
        const current = await repo.findJournalsByDates(owner, [op.review.date]);
        if (current[0]) return conflictResult(repo, [current[0]]);
        return failure(500, "journals_conflict");
      }
      if (!journal.id) return failure(500, "journal_unmapped");

      const prepared = parsed.prepared.get(op.review.date) ?? [];
      const itemRows: ItemRow[] = prepared.map((item) => ({
        id: item.id,
        journal_id: journal.id,
        type: item.type,
        content: item.content,
        sort_order: item.sort_order
      }));
      const qaRows = prepared.flatMap((item) => item.qas.map((qa) => ({ ...qa, item_id: item.id })));
      if (itemRows.length > 0) await repo.upsertItems(itemRows);
      await repo.deleteItemsExcept(journal.id, itemRows.map((item) => item.id));
      if (qaRows.length > 0) await repo.upsertQas(qaRows);
      if (itemRows.length > 0) await repo.deleteQasExcept(itemRows.map((item) => item.id), qaRows.map((qa) => qa.id));

      savedDates.push(op.review.date);
      updatedAtByDate[op.review.date] = journal.updated_at;
    }

    const deletedDates: string[] = [];
    for (const op of deletions) {
      if (!op.existing) {
        deletedDates.push(op.date);
        continue;
      }
      const deleted = await repo.deleteJournal(op.existing.id, owner, op.existing.updated_at);
      if (deleted === "conflict") {
        const current = await repo.findJournalsByDates(owner, [op.date]);
        if (!current[0]) {
          deletedDates.push(op.date);
          continue;
        }
        return conflictResult(repo, [current[0]]);
      }
      deletedDates.push(op.date);
    }

    return { status: 200, body: { ok: true, savedDates, deletedDates, updatedAtByDate } };
  } catch (error) {
    if (error instanceof ReviewsDbError) return failure(500, error.stage);
    throw error;
  }
};
