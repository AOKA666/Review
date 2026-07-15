import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../lib/supabase";

const OWNER_KEY = "weekly_summaries";

type WeeklyRecord = {
  date: string;
  red: string[];
  black: string[];
};

type WeeklySummaryRequest = {
  weekStart: string;
  weekEnd: string;
  language: "zh" | "en";
  records: WeeklyRecord[];
  force?: boolean;
};

type StoredWeeklySummary = {
  weekStart: string;
  weekEnd: string;
  language: "zh" | "en";
  summary: string;
  fingerprint?: string;
  updatedAt: string;
};

type WeeklySummaryStore = Record<string, StoredWeeklySummary>;

type MiniMaxChatResult = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
  base_resp?: { status_msg?: string };
};

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const summaryKey = (weekEnd: string, language: "zh" | "en") => `${weekEnd}:${language}`;

const readSummaryStore = async (supabase: SupabaseClient): Promise<WeeklySummaryStore> => {
  const { data, error } = await supabase
    .from("repano_reviews")
    .select("payload")
    .eq("owner", OWNER_KEY)
    .maybeSingle();

  if (error) throw error;
  if (!data?.payload || typeof data.payload !== "object" || Array.isArray(data.payload)) return {};
  return data.payload as WeeklySummaryStore;
};

const extractOutputText = (result: MiniMaxChatResult) => {
  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== "string") return "";
  return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
};

const isValidPayload = (payload: unknown): payload is WeeklySummaryRequest => {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Partial<WeeklySummaryRequest>;
  if (!value.weekStart || !DATE_KEY_PATTERN.test(value.weekStart)) return false;
  if (!value.weekEnd || !DATE_KEY_PATTERN.test(value.weekEnd)) return false;
  if (value.language !== "zh" && value.language !== "en") return false;
  if (!Array.isArray(value.records) || value.records.length > 7) return false;
  if (value.force !== undefined && typeof value.force !== "boolean") return false;

  return value.records.every(
    (record) =>
      record &&
      DATE_KEY_PATTERN.test(record.date) &&
      Array.isArray(record.red) &&
      Array.isArray(record.black) &&
      record.red.every((item) => typeof item === "string") &&
      record.black.every((item) => typeof item === "string")
  );
};

export async function GET() {
  try {
    const store = await readSummaryStore(getSupabaseAdmin());
    return NextResponse.json({ summaries: Object.values(store) });
  } catch (error) {
    console.error("Supabase weekly summaries read failed", error);
    return NextResponse.json({ summaries: [] }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "请求内容不是有效的 JSON" }, { status: 400 });
  }

  if (!isValidPayload(payload)) {
    return NextResponse.json({ error: "周复盘数据格式不正确" }, { status: 400 });
  }

  let supabase: SupabaseClient;
  let savedStore: WeeklySummaryStore;
  try {
    supabase = getSupabaseAdmin();
    savedStore = await readSummaryStore(supabase);
  } catch (error) {
    console.error("Supabase weekly summary lookup failed", error);
    return NextResponse.json({ error: "周复盘存储读取失败" }, { status: 500 });
  }

  const key = summaryKey(payload.weekEnd, payload.language);
  const saved = savedStore[key];
  if (!payload.force && saved?.summary) {
    return NextResponse.json({ summary: saved.summary, fingerprint: saved.fingerprint, saved: true });
  }

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "服务端未配置 MINIMAX_API_KEY" }, { status: 503 });
  }

  const trimmedRecords = payload.records.map((record) => ({
    date: record.date,
    red: record.red.map((item) => item.trim().slice(0, 2000)).filter(Boolean).slice(0, 100),
    black: record.black.map((item) => item.trim().slice(0, 2000)).filter(Boolean).slice(0, 100)
  }));

  const baseUrl = (process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1").replace(/\/$/, "");
  const systemPrompt =
    payload.language === "zh"
      ? "你是一位务实、克制的周复盘教练。只能依据用户提供的记录总结，不虚构事实。用中文输出，结构固定为：本周红榜、本周黑榜、关键规律、下周行动。合并重复内容，指出红黑榜之间可能的关联；下周行动给出 3 条具体、可执行、可检查的建议。使用简洁的 Markdown 小标题和项目符号。"
      : "You are a practical weekly review coach. Use only the supplied records and never invent facts. Respond in English with four concise Markdown sections: Red-list wins, Black-list lessons, Key patterns, and Next-week actions. Merge duplicates, connect related red and black items, and give exactly three concrete, checkable actions.";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.MINIMAX_MODEL || "MiniMax-M3",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Week: ${payload.weekStart} to ${payload.weekEnd}\n\nDaily records:\n${JSON.stringify(trimmedRecords, null, 2)}`
        }
      ],
      thinking: { type: "disabled" },
      temperature: 0.7,
      max_completion_tokens: 1200
    })
  });

  const result = (await response.json()) as MiniMaxChatResult;
  if (!response.ok) {
    const errorMessage = result.error?.message || result.base_resp?.status_msg;
    console.error("MiniMax weekly summary failed", response.status, errorMessage);
    return NextResponse.json(
      { error: errorMessage || "MiniMax 服务暂时不可用" },
      { status: response.status >= 400 && response.status < 500 ? 502 : response.status }
    );
  }

  const summary = extractOutputText(result);
  if (!summary) {
    return NextResponse.json({ error: "AI 没有返回可用的总结" }, { status: 502 });
  }

  const fingerprint = JSON.stringify({ language: payload.language, records: trimmedRecords });
  const persistedSummary: StoredWeeklySummary = {
    weekStart: payload.weekStart,
    weekEnd: payload.weekEnd,
    language: payload.language,
    summary,
    fingerprint,
    updatedAt: new Date().toISOString()
  };

  try {
    const latestStore = await readSummaryStore(supabase);
    const { error } = await supabase.from("repano_reviews").upsert(
      {
        owner: OWNER_KEY,
        payload: { ...latestStore, [key]: persistedSummary },
        updated_at: persistedSummary.updatedAt
      },
      { onConflict: "owner" }
    );
    if (error) throw error;
  } catch (error) {
    console.error("Supabase weekly summary save failed", error);
    return NextResponse.json({ error: "周复盘已生成，但保存失败，请重试" }, { status: 500 });
  }

  return NextResponse.json({ summary, fingerprint, saved: true });
}
