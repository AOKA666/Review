import {
  buildIdInFilterValue,
  buildJournalDateInFilterValue,
  PostgrestFilterError
} from "./postgrest-filter";
import {
  ItemRow,
  JournalRow,
  QaRow,
  ReviewsDbError,
  ReviewsRepository
} from "./reviews-service";

type PostgrestError = { message?: string; code?: string } | null;

type QueryResult = { data: unknown; error: PostgrestError };

export type ReviewsQueryBuilder = PromiseLike<QueryResult> & {
  select: (columns: string) => ReviewsQueryBuilder;
  insert: (row: unknown) => ReviewsQueryBuilder;
  upsert: (rows: unknown, options?: { onConflict?: string }) => ReviewsQueryBuilder;
  update: (row: unknown) => ReviewsQueryBuilder;
  delete: () => ReviewsQueryBuilder;
  eq: (column: string, value: string | boolean) => ReviewsQueryBuilder;
  order: (column: string, options?: { ascending?: boolean }) => ReviewsQueryBuilder;
  filter: (column: string, operator: string, value: string) => ReviewsQueryBuilder;
  not: (column: string, operator: string, value: string) => ReviewsQueryBuilder;
  single: () => Promise<QueryResult>;
};

export type ReviewsQueryClient = {
  from: (table: string) => ReviewsQueryBuilder;
};

const rowsOf = <T>(data: unknown): T[] => {
  if (!data) return [];
  return (Array.isArray(data) ? data : [data]) as T[];
};

const filterValue = (stage: string, build: () => string) => {
  try {
    return build();
  } catch (error) {
    if (error instanceof ReviewsDbError) throw error;
    throw new ReviewsDbError(stage, error);
  }
};

export class SupabaseReviewsRepository implements ReviewsRepository {
  constructor(private readonly supabase: ReviewsQueryClient) {}

  async listJournals(owner: string): Promise<JournalRow[]> {
    const { data, error } = await this.supabase
      .from("journals")
      .select("id, journal_date, created_at, updated_at")
      .eq("owner", owner)
      .order("journal_date", { ascending: false });
    if (error) throw new ReviewsDbError("journals_read", error);
    return rowsOf<JournalRow>(data);
  }

  async listItems(journalIds: string[]): Promise<ItemRow[]> {
    if (journalIds.length === 0) return [];
    const value = filterValue("items_read", () => buildIdInFilterValue(journalIds));
    const { data, error } = await this.supabase
      .from("journal_items")
      .select("id, journal_id, type, content, sort_order")
      .filter("journal_id", "in", value)
      .eq("is_deleted", false)
      .order("sort_order", { ascending: true });
    if (error) throw new ReviewsDbError("items_read", error);
    return rowsOf<ItemRow>(data);
  }

  async listQas(itemIds: string[]): Promise<QaRow[]> {
    if (itemIds.length === 0) return [];
    const value = filterValue("qas_read", () => buildIdInFilterValue(itemIds));
    const { data, error } = await this.supabase
      .from("journal_item_qas")
      .select("id, item_id, question, answer, show_answer, order_index")
      .filter("item_id", "in", value)
      .order("order_index", { ascending: true });
    if (error) throw new ReviewsDbError("qas_read", error);
    return rowsOf<QaRow>(data);
  }

  async findJournalsByDates(owner: string, dates: string[]): Promise<JournalRow[]> {
    const value = filterValue("journals_lookup", () => buildJournalDateInFilterValue(dates));
    const { data, error } = await this.supabase
      .from("journals")
      .select("id, journal_date, created_at, updated_at")
      .eq("owner", owner)
      .filter("journal_date", "in", value);
    if (error) throw new ReviewsDbError("journals_lookup", error);
    return rowsOf<JournalRow>(data);
  }

  async insertJournal(row: { id: string; owner: string; journal_date: string; created_at: string }): Promise<JournalRow | "conflict"> {
    const { data, error } = await this.supabase
      .from("journals")
      .insert(row)
      .select("id, journal_date, created_at, updated_at")
      .single();
    if (error?.code === "23505") return "conflict";
    if (error) throw new ReviewsDbError("journals_insert", error);
    const inserted = rowsOf<JournalRow>(data)[0];
    if (!inserted?.id) throw new ReviewsDbError("journal_unmapped");
    return inserted;
  }

  async claimJournal(id: string, owner: string, baseUpdatedAt: string): Promise<JournalRow | "conflict"> {
    const { data, error } = await this.supabase
      .from("journals")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("owner", owner)
      .eq("updated_at", baseUpdatedAt)
      .select("id, journal_date, created_at, updated_at");
    if (error) throw new ReviewsDbError("journals_claim", error);
    return rowsOf<JournalRow>(data)[0] ?? "conflict";
  }

  async upsertItems(rows: ItemRow[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.supabase
      .from("journal_items")
      .upsert(rows.map((row) => ({ ...row, is_deleted: false })), { onConflict: "id" });
    if (error) throw new ReviewsDbError("items_upsert", error);
  }

  async deleteItemsExcept(journalId: string, keepIds: string[]): Promise<void> {
    let query = this.supabase.from("journal_items").delete().eq("journal_id", journalId);
    if (keepIds.length > 0) {
      query = query.not("id", "in", filterValue("items_delete", () => buildIdInFilterValue(keepIds)));
    }
    const { error } = await query;
    if (error) throw new ReviewsDbError("items_delete", error);
  }

  async upsertQas(rows: QaRow[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.supabase.from("journal_item_qas").upsert(rows, { onConflict: "id" });
    if (error) throw new ReviewsDbError("qas_upsert", error);
  }

  async deleteQasExcept(itemIds: string[], keepIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    const itemFilter = filterValue("qas_delete", () => buildIdInFilterValue(itemIds));
    let query = this.supabase.from("journal_item_qas").delete().filter("item_id", "in", itemFilter);
    if (keepIds.length > 0) {
      query = query.not("id", "in", filterValue("qas_delete", () => buildIdInFilterValue(keepIds)));
    }
    const { error } = await query;
    if (error) throw new ReviewsDbError("qas_delete", error);
  }

  async deleteJournal(id: string, owner: string, baseUpdatedAt: string): Promise<"deleted" | "conflict"> {
    const { data, error } = await this.supabase
      .from("journals")
      .delete()
      .eq("id", id)
      .eq("owner", owner)
      .eq("updated_at", baseUpdatedAt)
      .select("id");
    if (error) throw new ReviewsDbError("journals_delete", error);
    return rowsOf<{ id: string }>(data).length > 0 ? "deleted" : "conflict";
  }
}
