import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../lib/supabase";
import { ReviewRecord, LogItem, QaPair } from "../../../lib/review";

const OWNER_KEY = "default";

type SelectResponse =
  | { reviews: ReviewRecord[]; updated_at: string | null }
  | { reviews: []; updated_at: null };

/* ============================================================
   GET — 从规范化表读取并组装成前端期望的 ReviewRecord[]
   ============================================================ */
export async function GET(): Promise<NextResponse<SelectResponse>> {
  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (error) {
    console.error("Supabase init error", error);
    return NextResponse.json(
      { reviews: [], updated_at: null },
      { status: 500, statusText: "Supabase env not configured" }
    );
  }

  // 1. 获取所有 journals
  const { data: journals, error: journalsError } = await supabase
    .from("journals")
    .select("id, journal_date, created_at, updated_at")
    .eq("owner", OWNER_KEY)
    .order("journal_date", { ascending: false });

  if (journalsError) {
    console.error("Supabase GET journals error", journalsError);
    return NextResponse.json({ reviews: [], updated_at: null }, { status: 500 });
  }

  if (!journals || journals.length === 0) {
    return NextResponse.json({ reviews: [], updated_at: null });
  }

  const journalIds = journals.map((j) => j.id);

  // 2. 获取关联的 items（排除软删除）
  const { data: items, error: itemsError } = await supabase
    .from("journal_items")
    .select("id, journal_id, type, content, sort_order")
    .in("journal_id", journalIds)
    .eq("is_deleted", false)
    .order("sort_order", { ascending: true });

  if (itemsError) {
    console.error("Supabase GET items error", itemsError);
    return NextResponse.json({ reviews: [], updated_at: null }, { status: 500 });
  }

  const itemIds = items?.map((i) => i.id) ?? [];

  // 3. 获取关联的 qas
  const { data: qas, error: qasError } = await supabase
    .from("journal_item_qas")
    .select("id, item_id, question, answer, show_answer, order_index")
    .in("item_id", itemIds)
    .order("order_index", { ascending: true });

  if (qasError) {
    console.error("Supabase GET qas error", qasError);
    return NextResponse.json({ reviews: [], updated_at: null }, { status: 500 });
  }

  // 4. 按 journal_id / item_id 分组
  const itemsByJournal = new Map<string, typeof items>();
  items?.forEach((item) => {
    const list = itemsByJournal.get(item.journal_id) ?? [];
    list.push(item);
    itemsByJournal.set(item.journal_id, list);
  });

  const qasByItem = new Map<string, typeof qas>();
  qas?.forEach((qa) => {
    const list = qasByItem.get(qa.item_id) ?? [];
    list.push(qa);
    qasByItem.set(qa.item_id, list);
  });

  // 5. 组装成 ReviewRecord[]
  const reviews: ReviewRecord[] = journals.map((journal) => {
    const journalItems = itemsByJournal.get(journal.id) ?? [];
    const red: LogItem[] = [];
    const black: LogItem[] = [];

    journalItems.forEach((item) => {
      const itemQas = qasByItem.get(item.id) ?? [];
      const logItem: LogItem = {
        id: item.id,
        text: item.content,
        order_index: item.sort_order,
        reflection_qas: itemQas.map(
          (qa): QaPair => ({
            id: qa.id,
            question: qa.question,
            answer: qa.answer,
            showAnswer: qa.show_answer,
            order_index: qa.order_index,
          })
        ),
      };

      if (item.type === "red") {
        red.push(logItem);
      } else {
        black.push(logItem);
      }
    });

    return {
      id: journal.id,
      date: journal.journal_date,
      created_at: journal.created_at,
      updated_at: journal.updated_at,
      today_log: { red, black },
    };
  });

  const latestUpdatedAt =
    journals
      .map((j) => j.updated_at)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;

  return NextResponse.json({ reviews, updated_at: latestUpdatedAt });
}

/* ============================================================
   POST — 接收前端 ReviewRecord[]，保存到三张规范化表
   ============================================================ */
export async function POST(
  request: Request
): Promise<NextResponse<{ ok: boolean }>> {
  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (error) {
    console.error("Supabase init error", error);
    return NextResponse.json(
      { ok: false },
      { status: 500, statusText: "Supabase env not configured" }
    );
  }

  let payload: { reviews: ReviewRecord[] };
  try {
    payload = await request.json();
  } catch (error) {
    return NextResponse.json(
      { ok: false },
      { status: 400, statusText: "Invalid JSON payload" }
    );
  }

  if (!Array.isArray(payload.reviews)) {
    return NextResponse.json(
      { ok: false },
      { status: 400, statusText: "Expected reviews array" }
    );
  }

  const datesToKeep = payload.reviews.map((r) => r.date);
  const allItemIds = new Set<string>();
  const allQaIds = new Set<string>();

  // ---------- Step 1: 批量 upsert journals ----------
  const journalsData = payload.reviews.map((review) => ({
    id: review.id,
    owner: OWNER_KEY,
    journal_date: review.date,
    created_at: review.created_at,
    updated_at: review.updated_at,
  }));

  const { error: journalsUpsertError } = await supabase
    .from("journals")
    .upsert(journalsData, { onConflict: "owner,journal_date" });

  if (journalsUpsertError) {
    console.error("Supabase POST journals upsert error", journalsUpsertError);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  // ---------- Step 2: 查询刚写入的 journals，建立 date -> id 映射 ----------
  const { data: insertedJournals, error: journalsQueryError } = await supabase
    .from("journals")
    .select("id, journal_date")
    .eq("owner", OWNER_KEY)
    .in("journal_date", datesToKeep);

  if (journalsQueryError || !insertedJournals) {
    console.error("Supabase POST journals query error", journalsQueryError);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  const dateToId = new Map(insertedJournals.map((j) => [j.journal_date, j.id]));

  // ---------- Step 3: 收集 items 和 qas ----------
  const itemsData: Array<{
    id: string;
    journal_id: string;
    type: "red" | "black";
    content: string;
    sort_order: number;
  }> = [];

  const qasData: Array<{
    id: string;
    item_id: string;
    question: string;
    answer: string;
    show_answer: boolean;
    order_index: number;
  }> = [];

  for (const review of payload.reviews) {
    const journalId = dateToId.get(review.date);
    if (!journalId) continue;

    for (const item of review.today_log.red) {
      allItemIds.add(item.id);
      itemsData.push({
        id: item.id,
        journal_id: journalId,
        type: "red",
        content: item.text,
        sort_order: item.order_index,
      });
      for (const qa of item.reflection_qas) {
        allQaIds.add(qa.id);
        qasData.push({
          id: qa.id,
          item_id: item.id,
          question: qa.question,
          answer: qa.answer,
          show_answer: qa.showAnswer,
          order_index: qa.order_index,
        });
      }
    }

    for (const item of review.today_log.black) {
      allItemIds.add(item.id);
      itemsData.push({
        id: item.id,
        journal_id: journalId,
        type: "black",
        content: item.text,
        sort_order: item.order_index,
      });
      for (const qa of item.reflection_qas) {
        allQaIds.add(qa.id);
        qasData.push({
          id: qa.id,
          item_id: item.id,
          question: qa.question,
          answer: qa.answer,
          show_answer: qa.showAnswer,
          order_index: qa.order_index,
        });
      }
    }
  }

  // ---------- Step 4: 批量 upsert items ----------
  if (itemsData.length > 0) {
    const { error: itemsUpsertError } = await supabase
      .from("journal_items")
      .upsert(itemsData, { onConflict: "id" });

    if (itemsUpsertError) {
      console.error("Supabase POST items upsert error", itemsUpsertError);
      return NextResponse.json({ ok: false }, { status: 500 });
    }
  }

  // ---------- Step 5: 删除不在 payload 中的 items ----------
  const journalIds = Array.from(dateToId.values());
  if (journalIds.length > 0) {
    const { data: existingItems, error: existingItemsError } = await supabase
      .from("journal_items")
      .select("id")
      .in("journal_id", journalIds)
      .eq("is_deleted", false);

    if (!existingItemsError && existingItems) {
      const toDeleteItemIds = existingItems
        .filter((i) => !allItemIds.has(i.id))
        .map((i) => i.id);

      if (toDeleteItemIds.length > 0) {
        const { error: deleteItemsError } = await supabase
          .from("journal_items")
          .delete()
          .in("id", toDeleteItemIds);

        if (deleteItemsError) {
          console.error("Supabase POST delete items error", deleteItemsError);
        }
      }
    }
  }

  // ---------- Step 6: 批量 upsert qas ----------
  if (qasData.length > 0) {
    const { error: qasUpsertError } = await supabase
      .from("journal_item_qas")
      .upsert(qasData, { onConflict: "id" });

    if (qasUpsertError) {
      console.error("Supabase POST qas upsert error", qasUpsertError);
      return NextResponse.json({ ok: false }, { status: 500 });
    }
  }

  // ---------- Step 7: 删除不在 payload 中的 qas ----------
  const itemIdsArray = Array.from(allItemIds);
  if (itemIdsArray.length > 0) {
    const { data: existingQas, error: existingQasError } = await supabase
      .from("journal_item_qas")
      .select("id")
      .in("item_id", itemIdsArray);

    if (!existingQasError && existingQas) {
      const toDeleteQaIds = existingQas
        .filter((q) => !allQaIds.has(q.id))
        .map((q) => q.id);

      if (toDeleteQaIds.length > 0) {
        const { error: deleteQasError } = await supabase
          .from("journal_item_qas")
          .delete()
          .in("id", toDeleteQaIds);

        if (deleteQasError) {
          console.error("Supabase POST delete qas error", deleteQasError);
        }
      }
    }
  }

  // ---------- Step 8: 删除不在 payload 中的 journals ----------
  if (datesToKeep.length === 0) {
    const { error: deleteJournalsError } = await supabase
      .from("journals")
      .delete()
      .eq("owner", OWNER_KEY);

    if (deleteJournalsError) {
      console.error(
        "Supabase POST delete all journals error",
        deleteJournalsError
      );
    }
  } else {
    const { error: deleteJournalsError } = await supabase
      .from("journals")
      .delete()
      .eq("owner", OWNER_KEY)
      .not("journal_date", "in", datesToKeep);

    if (deleteJournalsError) {
      console.error(
        "Supabase POST delete stale journals error",
        deleteJournalsError
      );
    }
  }

  return NextResponse.json({ ok: true });
}
