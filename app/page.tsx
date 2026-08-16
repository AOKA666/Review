"use client";

import { ChangeEvent, Fragment, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { reconcileMonthCollapseState } from "../lib/history-months";
import { LogItem, QaPair, ReviewRecord, TodayLog } from "../lib/review";
import { reviewsToMarkdown } from "../lib/review-markdown";
import { authorizeObsidianDirectory } from "../lib/obsidian-authorization";
import {
  hasWritePermission,
  loadDirectoryHandle,
  ObsidianDirectoryHandle,
  ObsidianSyncStatus,
  pickDirectory,
  requestWritePermission,
  saveDirectoryHandle,
  supportsObsidianSync,
  syncReviewToDirectory
} from "../lib/obsidian-sync";
import { mergeReviewsByDate } from "../lib/review-merge";
import { persistWithLocalFallback } from "../lib/save-status";
import { parseWeeklySummary } from "../lib/weekly-summary";
import {
  shouldGenerateWeeklySummary,
  WeeklySummaryState,
  weeklySummaryKey
} from "../lib/weekly-summary-cache";

type SaveStatus = "ready" | "saving" | "saved" | "error";
type LogColumn = "red" | "black";
type Lang = "zh" | "en";

const STORAGE_KEY = "repano_reviews";
const LANG_KEY = "repano_lang";
const WEEKLY_SUMMARY_KEY = "repano_weekly_summaries";

const i18n = {
  zh: {
    topTag: "今日记录",
    title: "复盘日志",
    status: { ready: "就绪", saving: "保存中...", saved: "已保存", error: "保存失败（点击重试）" },
    langZh: "中文",
    langEn: "EN",
    newToday: "新建记录",
    exportMarkdown: "导出 Markdown",
    obsidian: { unsupported: "浏览器不支持 Obsidian 同步", disconnected: "同步到 Obsidian", connected: "Obsidian 已连接", permission: "重新授权 Obsidian", syncing: "同步到 Obsidian…", synced: "已同步到 Obsidian", error: "Obsidian 同步失败" },
    changeObsidianFolder: "更换 Obsidian 文件夹",
    collapse: "折叠",
    updatedAt: "更新于",
    emptyRecord: "暂无记录",
    autosaveHint: "自动保存，停止输入 1 秒后同步",
    deleteDay: "删除这一天",
    expandHistory: "展开历史",
    collapseHistory: "折叠历史",
    emptyTip: "点击左侧日期或新建今日记录开始。",
    todayLog: "Today Log",
    redBoard: "红榜",
    blackBoard: "黑榜",
    confirmDeleteDay: (date: string) => `确认删除 ${date} 的记录吗？`,
    itemPlaceholder: "输入一条记录，回车新增下一条",
    reflectDeeper: "reflect deeper",
    deepDive: "深度挖掘",
    qaSummary: (count: number) => `已记录 ${count} 轮 QA，点击展开`,
    deleteQa: "删除 QA",
    qPlaceholder: "输入问题，回车进入回答",
    aPlaceholder: "输入回答，回车新增下一轮",
    delete: "删除",
    addFirstQa: "+ 新增第一轮 QA",
    weeklyReview: "周复盘",
    weeklyRange: (start: string, end: string) => `${start} 至 ${end}`,
    weeklyLoading: "AI 正在总结本周的红榜和黑榜…",
    weeklyEmpty: "这一周还没有可总结的红榜或黑榜记录。",
    weeklyError: "周复盘生成失败",
    retryWeekly: "重试",
    regenerateWeekly: "重新生成"
  },
  en: {
    topTag: "Today Log",
    title: "Review Log",
    status: { ready: "Ready", saving: "Saving...", saved: "Saved", error: "Save failed (click to retry)" },
    langZh: "中文",
    langEn: "EN",
    newToday: "New entry",
    exportMarkdown: "Export Markdown",
    obsidian: { unsupported: "Obsidian sync unsupported", disconnected: "Sync to Obsidian", connected: "Obsidian connected", permission: "Authorize Obsidian", syncing: "Syncing to Obsidian…", synced: "Synced to Obsidian", error: "Obsidian sync failed" },
    changeObsidianFolder: "Change Obsidian folder",
    collapse: "Collapse",
    updatedAt: "Updated",
    emptyRecord: "No records yet",
    autosaveHint: "Auto-saves 1 second after you stop typing",
    deleteDay: "Delete this day",
    expandHistory: "Expand history",
    collapseHistory: "Collapse history",
    emptyTip: "Pick a date on the left or create today to start.",
    todayLog: "Today Log",
    redBoard: "Red List",
    blackBoard: "Black List",
    confirmDeleteDay: (date: string) => `Delete record for ${date}?`,
    itemPlaceholder: "Type one item, press Enter to add the next",
    reflectDeeper: "reflect deeper",
    deepDive: "Deep Dive",
    qaSummary: (count: number) => `${count} QA rounds recorded, click to expand`,
    deleteQa: "Delete QA",
    qPlaceholder: "Type your question, Enter to answer",
    aPlaceholder: "Type your answer, Enter for next round",
    delete: "Delete",
    addFirstQa: "+ Add first QA round",
    weeklyReview: "Weekly Review",
    weeklyRange: (start: string, end: string) => `${start} to ${end}`,
    weeklyLoading: "AI is summarizing this week's red and black lists…",
    weeklyEmpty: "There are no red or black list entries to summarize this week.",
    weeklyError: "Could not generate the weekly review",
    retryWeekly: "Retry",
    regenerateWeekly: "Regenerate"
  }
} as const;

const randomId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

const todayKey = () => new Date().toISOString().slice(0, 10);

const buildQaPair = (index = 0): QaPair => ({ id: randomId(), question: "", answer: "", showAnswer: false, order_index: index });
const normalizeQa = (raw: unknown, index: number): QaPair => {
  const qa = (raw ?? {}) as Partial<QaPair>;
  const answer = typeof qa.answer === "string" ? qa.answer : "";
  return {
    id: typeof qa.id === "string" ? qa.id : randomId(),
    question: typeof qa.question === "string" ? qa.question : "",
    answer,
    showAnswer: typeof qa.showAnswer === "boolean" ? qa.showAnswer : Boolean(answer),
    order_index: typeof qa.order_index === "number" ? qa.order_index : index
  };
};
const syncQaOrder = (qas: QaPair[]) => qas.map((qa, idx) => ({ ...qa, order_index: idx }));

const buildLogItem = (index = 0, text = ""): LogItem => ({ id: randomId(), text, order_index: index, reflection_qas: [] });
const syncLogOrder = (items: LogItem[]) => items.map((item, idx) => ({ ...item, order_index: idx }));

const normalizeLogItems = (raw: unknown): LogItem[] => {
  if (!Array.isArray(raw)) return [buildLogItem(0)];
  const items = raw.map((entry, index) => {
    const item = (entry ?? {}) as Partial<LogItem>;
    const reflection = Array.isArray(item.reflection_qas)
      ? syncQaOrder(item.reflection_qas.map((qa, qaIndex) => normalizeQa(qa, qaIndex)))
      : [];
    return {
      id: typeof item.id === "string" ? item.id : randomId(),
      text: typeof item.text === "string" ? item.text : "",
      order_index: typeof item.order_index === "number" ? item.order_index : index,
      reflection_qas: reflection
    };
  });
  return syncLogOrder(items.length ? items : [buildLogItem(0)]);
};

const emptyTodayLog = (): TodayLog => ({ red: [buildLogItem(0)], black: [buildLogItem(0)] });
const buildReview = (date: string): ReviewRecord => ({
  id: randomId(), date, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), today_log: emptyTodayLog()
});

const normalizeReview = (raw: unknown): ReviewRecord => {
  const input = (raw ?? {}) as Partial<ReviewRecord> & {
    reflection?: { qas?: unknown[]; whatHappened?: string; why?: string; optimization?: string };
    rows?: Array<{ context?: string; qas?: Array<{ question?: string }>; solutions?: string }>;
  };

  const dailyLogFallback =
    typeof input.daily_log === "string"
      ? input.daily_log
      : Array.isArray(input.rows)
      ? input.rows.map((row) => (typeof row.context === "string" ? row.context : "")).filter(Boolean).join("\n")
      : "";

  const legacyWhat =
    typeof input.reflection?.whatHappened === "string"
      ? input.reflection.whatHappened
      : Array.isArray(input.rows)
      ? input.rows.flatMap((row) => (Array.isArray(row.qas) ? row.qas : [])).map((qa) => (typeof qa.question === "string" ? qa.question : "")).filter(Boolean).join("\n")
      : "";

  const legacyWhy = typeof input.reflection?.why === "string" ? input.reflection.why : "";
  const legacyOptimization =
    typeof input.reflection?.optimization === "string"
      ? input.reflection.optimization
      : Array.isArray(input.rows)
      ? input.rows.map((row) => (typeof row.solutions === "string" ? row.solutions : "")).filter(Boolean).join("\n")
      : "";

  const legacyReflectionQas = Array.isArray(input.reflection?.qas)
    ? syncQaOrder(input.reflection.qas.map((qa, index) => normalizeQa(qa, index)))
    : [];

  const todayLogInput = input.today_log as Partial<TodayLog> | undefined;
  const redItems = normalizeLogItems(todayLogInput?.red);
  const blackItems = normalizeLogItems(todayLogInput?.black);

  if (!todayLogInput?.red && dailyLogFallback.trim()) redItems[0] = { ...redItems[0], text: dailyLogFallback };

  if (!todayLogInput?.red && (legacyReflectionQas.length || legacyWhat || legacyWhy || legacyOptimization)) {
    const legacyQuestion = [legacyWhat, legacyWhy].filter(Boolean).join("\n").trim();
    const mergedLegacyQas = legacyReflectionQas.length
      ? legacyReflectionQas
      : [{ ...buildQaPair(0), question: legacyQuestion, answer: legacyOptimization, showAnswer: Boolean(legacyOptimization) }];
    redItems[0] = { ...redItems[0], reflection_qas: syncQaOrder(mergedLegacyQas) };
  }

  return {
    id: typeof input.id === "string" ? input.id : randomId(),
    date: typeof input.date === "string" ? input.date : todayKey(),
    created_at: typeof input.created_at === "string" ? input.created_at : new Date().toISOString(),
    updated_at: typeof input.updated_at === "string" ? input.updated_at : new Date().toISOString(),
    today_log: { red: syncLogOrder(redItems), black: syncLogOrder(blackItems) }
  };
};

const sortReviews = (list: ReviewRecord[]) => [...list].sort((a, b) => b.date.localeCompare(a.date));
const hasItemReflectionContent = (item: LogItem) => item.reflection_qas.some((qa) => qa.question.trim() || qa.answer.trim());

const renderInlineMarkdown = (text: string) =>
  text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>
      : <span key={index}>{part}</span>
  );

const weeklySectionTheme = (title: string) => {
  if (/红榜|red.list/i.test(title)) return { icon: "✓", card: "border-rose-200 bg-rose-50/70", iconClass: "bg-rose-100 text-rose-700", titleClass: "text-rose-800" };
  if (/黑榜|black.list/i.test(title)) return { icon: "!", card: "border-slate-300 bg-slate-50", iconClass: "bg-slate-200 text-slate-700", titleClass: "text-slate-800" };
  if (/规律|patterns/i.test(title)) return { icon: "◆", card: "border-amber-200 bg-amber-50/70", iconClass: "bg-amber-100 text-amber-700", titleClass: "text-amber-800" };
  if (/行动|actions/i.test(title)) return { icon: "→", card: "border-emerald-200 bg-emerald-50/70", iconClass: "bg-emerald-100 text-emerald-700", titleClass: "text-emerald-800" };
  return { icon: "•", card: "border-violet-200 bg-violet-50/70", iconClass: "bg-violet-100 text-violet-700", titleClass: "text-violet-800" };
};

const parseDateKey = (date: string) => new Date(`${date}T00:00:00`);
const dateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const weekStartKey = (sunday: string) => {
  const start = parseDateKey(sunday);
  start.setDate(start.getDate() - 6);
  return dateKey(start);
};
const isSunday = (date: string) => parseDateKey(date).getDay() === 0;

export default function HomePage() {
  const [lang, setLang] = useState<Lang>("zh");
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentWeeklyEnd, setCurrentWeeklyEnd] = useState<string | null>(null);
  const [weeklySummaries, setWeeklySummaries] = useState<Record<string, WeeklySummaryState>>({});
  const [status, setStatus] = useState<SaveStatus>("ready");
  const [obsidianStatus, setObsidianStatus] = useState<ObsidianSyncStatus>("disconnected");
  const [isHistoryCollapsed, setIsHistoryCollapsed] = useState(false);
  const [expandedItemIds, setExpandedItemIds] = useState<Record<string, boolean>>({});
  const [monthCollapseState, setMonthCollapseState] = useState(() => ({
    collapsedMonths: new Set<string>(),
    knownMonths: new Set<string>()
  }));
  const collapsedMonths = monthCollapseState.collapsedMonths;

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestReviews = useRef<ReviewRecord[]>([]);
  const currentIdRef = useRef<string | null>(null);
  type PendingFocusTarget =
    | { type: "item"; column: LogColumn; itemId: string }
    | { type: "qa"; column: LogColumn; itemId: string; qaId: string; field: "question" | "answer" };
  const pendingFocusRef = useRef<PendingFocusTarget | null>(null);
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const obsidianDirectoryRef = useRef<ObsidianDirectoryHandle | null>(null);

  const adjustTextAreaHeight = (target: HTMLTextAreaElement) => {
    target.style.height = "auto";
    target.style.height = `${target.scrollHeight}px`;
  };

  const t = i18n[lang];
  const formatHeaderDate = (dateStr: string) => {
    const date = parseDateKey(dateStr);
    if (lang === "zh") {
      const d = new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(date);
      const w = new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date);
      return `${d}, ${w}`;
    }
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short"
    }).format(date);
  };

  const currentReview = useMemo(() => reviews.find((item) => item.id === currentId) ?? null, [reviews, currentId]);

  const groupedReviews = useMemo(() => {
    const map = new Map<string, ReviewRecord[]>();
    for (const review of reviews) {
      const monthKey = review.date.slice(0, 7);
      const list = map.get(monthKey) ?? [];
      list.push(review);
      map.set(monthKey, list);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [reviews]);

  const getWeekReviews = (weekEnd: string) => {
    const start = weekStartKey(weekEnd);
    return reviews
      .filter((review) => review.date >= start && review.date <= weekEnd)
      .sort((a, b) => a.date.localeCompare(b.date));
  };

  const formatHistoryDate = (dateStr: string) => {
    const weekday = new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", { weekday: "short" })
      .format(parseDateKey(dateStr));
    return `${dateStr.replace(/-/g, ".")} ${weekday}`;
  };

  const generateWeeklyReview = async (weekEnd: string, force = false) => {
    const weekReviews = getWeekReviews(weekEnd);
    const records = weekReviews.map((review) => ({
      date: review.date,
      red: review.today_log.red.map((item) => item.text.trim()).filter(Boolean),
      black: review.today_log.black.map((item) => item.text.trim()).filter(Boolean)
    }));
    const cacheKey = weeklySummaryKey(weekEnd, lang);
    const fingerprint = JSON.stringify({ language: lang, records });
    const cached = weeklySummaries[cacheKey];

    if (!shouldGenerateWeeklySummary(cached, force)) return;

    if (!records.some((record) => record.red.length || record.black.length)) {
      setWeeklySummaries((prev) => ({ ...prev, [cacheKey]: { status: "ready", fingerprint } }));
      return;
    }

    setWeeklySummaries((prev) => ({ ...prev, [cacheKey]: { status: "loading", fingerprint } }));
    try {
      const response = await fetch("/api/weekly-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weekStart: weekStartKey(weekEnd),
          weekEnd,
          language: lang,
          records,
          force
        })
      });
      const data = (await response.json()) as { summary?: string; fingerprint?: string; error?: string };
      if (!response.ok || !data.summary) throw new Error(data.error || "AI summary failed");
      setWeeklySummaries((prev) => ({
        ...prev,
        [cacheKey]: { status: "ready", summary: data.summary, fingerprint: data.fingerprint ?? fingerprint }
      }));
    } catch (error) {
      setWeeklySummaries((prev) => ({
        ...prev,
        [cacheKey]: {
          status: "error",
          fingerprint,
          error: error instanceof Error ? error.message : "AI summary failed"
        }
      }));
    }
  };

  const selectWeeklyReview = (weekEnd: string) => {
    setCurrentId(null);
    setCurrentWeeklyEnd(weekEnd);
  };

  const selectDailyReview = (id: string) => {
    setCurrentWeeklyEnd(null);
    setCurrentId(id);
  };

  const toggleMonth = (monthKey: string) => {
    setMonthCollapseState((previous) => {
      const next = new Set(previous.collapsedMonths);
      if (next.has(monthKey)) next.delete(monthKey);
      else next.add(monthKey);
      return { ...previous, collapsedMonths: next };
    });
  };

  const formatMonthLabel = (monthKey: string) => {
    const date = parseDateKey(`${monthKey}-01`);
    if (lang === "zh") {
      return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(date);
    }
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long" }).format(date);
  };

  const setReviewsDirect = (next: ReviewRecord[]) => {
    const sorted = sortReviews(next.map(normalizeReview));
    latestReviews.current = sorted;
    setReviews(sorted);
  };

  const updateReviews = (updater: (prev: ReviewRecord[]) => ReviewRecord[]) => {
    setReviews((prev) => {
      const now = new Date().toISOString();
      const updated = updater(prev).map((review) =>
        review.id === currentIdRef.current ? { ...review, updated_at: now } : review
      );
      const sorted = sortReviews(updated.map(normalizeReview));
      latestReviews.current = sorted;
      persistLocally(sorted);
      return sorted;
    });
  };

  const persistLocally = (list: ReviewRecord[]) => {
    if (typeof window === "undefined") return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sortReviews(list)));
      return true;
    } catch (error) {
      console.error("Local save failed", error);
      setStatus("error");
      return false;
    }
  };

  const saveToSupabase = async (payload: ReviewRecord[]) => {
    const response = await fetch("/api/reviews", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviews: payload })
    });
    if (!response.ok) {
      const failure = await response.text();
      throw new Error(failure || "Supabase write failed");
    }
  };
  const syncCurrentReviewToObsidian = async (payload: ReviewRecord[]) => {
    const handle = obsidianDirectoryRef.current;
    const review = payload.find((item) => item.id === currentIdRef.current);
    if (!handle || !review) return;
    if (!(await hasWritePermission(handle))) {
      setObsidianStatus("permission");
      return;
    }
    setObsidianStatus("syncing");
    try {
      await syncReviewToDirectory(handle, review);
      setObsidianStatus("synced");
    } catch (error) {
      console.error("Obsidian sync failed", error);
      setObsidianStatus("error");
    }
  };

  const handleObsidianConnect = async () => {
    if (!supportsObsidianSync()) { setObsidianStatus("unsupported"); return; }
    try {
      const handle = await authorizeObsidianDirectory(obsidianDirectoryRef.current, {
        pick: pickDirectory,
        requestPermission: requestWritePermission,
        save: saveDirectoryHandle
      });
      if (!handle) {
        setObsidianStatus("permission");
        return;
      }
      obsidianDirectoryRef.current = handle;
      setObsidianStatus("connected");
      await syncCurrentReviewToObsidian(latestReviews.current);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("Obsidian connection failed", error);
      setObsidianStatus("error");
    }
  };

  const persistNow = async () => {
    if (typeof window === "undefined") return;
    if (!latestReviews.current.length) return;

    const now = new Date().toISOString();
    const updated = latestReviews.current.map((review) =>
      review.id === currentIdRef.current ? { ...review, updated_at: now } : review
    );
    const payload = sortReviews(updated);

    setReviewsDirect(payload);
    void syncCurrentReviewToObsidian(payload);
    const nextStatus = await persistWithLocalFallback({
      saveLocal: () => persistLocally(payload),
      saveRemote: () => saveToSupabase(payload),
      reportRemoteError: (error) => console.warn("Supabase sync deferred; local copy is saved", error)
    });
    setStatus(nextStatus);
  };

  const scheduleSave = () => {
    setStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persistNow(); }, 1000);
  };

  const loadLocalReviews = (): ReviewRecord[] => {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown[];
      return Array.isArray(parsed) ? parsed.map(normalizeReview) : [];
    } catch (error) {
      console.error("Local load failed", error);
      return [];
    }
  };

  const hydrateReviewList = (source: ReviewRecord[]) => {
    const normalized = sortReviews(source.map(normalizeReview));
    const today = todayKey();
    const todayReview = normalized.find((item) => item.date === today);

    if (todayReview) {
      setReviewsDirect(normalized);
      setCurrentId(todayReview.id);
      setCurrentWeeklyEnd(null);
      persistLocally(normalized);
      return;
    }

    const next = sortReviews([buildReview(today), ...normalized]);
    setReviewsDirect(next);
    setCurrentId(next[0]?.id ?? null);
    setCurrentWeeklyEnd(null);
    persistLocally(next);
  };

  const handleNewReview = (date: string) => {
    const existed = reviews.find((item) => item.date === date);
    if (existed) { selectDailyReview(existed.id); return; }

    const next = sortReviews([buildReview(date), ...reviews]);
    setReviewsDirect(next);
    setCurrentId(next[0]?.id ?? null);
    setCurrentWeeklyEnd(null);
    setStatus("saved");
    void persistNow();
  };

  const handleDateSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const date = event.target.value;
    if (!date) return;
    handleNewReview(date);
    event.target.value = "";
  };

  const handleDeleteCurrentReview = () => {
    if (!currentReview) return;
    if (typeof window !== "undefined" && !window.confirm(t.confirmDeleteDay(currentReview.date))) return;

    const remaining = reviews.filter((item) => item.id !== currentReview.id);
    const nextList = remaining.length ? remaining : [buildReview(todayKey())];
    const nextCurrentId = nextList[0]?.id ?? null;

    setReviewsDirect(nextList);
    setCurrentId(nextCurrentId);
    currentIdRef.current = nextCurrentId;
    persistLocally(nextList);

    setStatus("saving");
    void (async () => {
      try { await saveToSupabase(sortReviews(nextList)); setStatus("saved"); }
      catch (error) { console.error("Supabase delete sync failed", error); setStatus("error"); }
    })();
  };

  const handleExportMarkdown = () => {
    if (typeof window === "undefined" || !reviews.length) return;
    const markdown = reviewsToMarkdown(reviews);
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `review-log-${todayKey()}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const updateCurrentReview = (updater: (review: ReviewRecord) => ReviewRecord) => {
    if (!currentId) return;
    updateReviews((prev) => prev.map((review) => (review.id === currentId ? updater(review) : review)));
    scheduleSave();
  };

  const upsertItem = (review: ReviewRecord, column: LogColumn, itemId: string, updater: (item: LogItem) => LogItem) => {
    const nextColumn = syncLogOrder(review.today_log[column].map((item) => (item.id === itemId ? updater(item) : item)));
    return { ...review, today_log: { ...review.today_log, [column]: nextColumn } };
  };

  const handleItemTextChange = (column: LogColumn, itemId: string, value: string) => {
    updateCurrentReview((review) => upsertItem(review, column, itemId, (item) => ({ ...item, text: value })));
  };

  const handleAddItem = (column: LogColumn, afterItemId: string) => {
    updateCurrentReview((review) => {
      const list = [...review.today_log[column]];
      const index = list.findIndex((item) => item.id === afterItemId);
      if (index < 0) return review;

      const nextItem = buildLogItem(list.length);
      list.splice(index + 1, 0, nextItem);
      pendingFocusRef.current = { type: "item", column, itemId: nextItem.id };
      return { ...review, today_log: { ...review.today_log, [column]: syncLogOrder(list) } };
    });
  };

  const handleDeleteItem = (column: LogColumn, itemId: string) => {
    updateCurrentReview((review) => {
      const list = [...review.today_log[column]];
      if (list.length <= 1) return review;

      const index = list.findIndex((item) => item.id === itemId);
      if (index < 0) return review;

      const fallback = list[index - 1] ?? list[index + 1] ?? null;
      if (fallback) pendingFocusRef.current = { type: "item", column, itemId: fallback.id };

      list.splice(index, 1);
      return { ...review, today_log: { ...review.today_log, [column]: syncLogOrder(list) } };
    });
  };

  const handleItemKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, column: LogColumn, itemId: string) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleAddItem(column, itemId);
      return;
    }

    if (event.key === "Backspace" && !event.shiftKey) {
      const value = event.currentTarget.value;
      if (!value.trim()) {
        event.preventDefault();
        handleDeleteItem(column, itemId);
      }
    }
  };

  const handleToggleReflection = (column: LogColumn, itemId: string) => {
    const isExpanded = Boolean(expandedItemIds[itemId]);
    if (isExpanded) { setExpandedItemIds((prev) => ({ ...prev, [itemId]: false })); return; }

    updateCurrentReview((review) =>
      upsertItem(review, column, itemId, (item) => ({
        ...item,
        reflection_qas: item.reflection_qas.length ? item.reflection_qas : [buildQaPair(0)]
      }))
    );
    setExpandedItemIds((prev) => ({ ...prev, [itemId]: true }));
  };

  const handleQaQuestionChange = (column: LogColumn, itemId: string, qaId: string, value: string) => {
    updateCurrentReview((review) =>
      upsertItem(review, column, itemId, (item) => ({
        ...item,
        reflection_qas: syncQaOrder(item.reflection_qas.map((qa) => (qa.id === qaId ? { ...qa, question: value } : qa)))
      }))
    );
  };

  const handleQaAnswerChange = (column: LogColumn, itemId: string, qaId: string, value: string) => {
    updateCurrentReview((review) =>
      upsertItem(review, column, itemId, (item) => ({
        ...item,
        reflection_qas: syncQaOrder(item.reflection_qas.map((qa) => (qa.id === qaId ? { ...qa, answer: value, showAnswer: true } : qa)))
      }))
    );
  };

  const handleShowAnswer = (column: LogColumn, itemId: string, qaId: string) => {
    updateCurrentReview((review) =>
      upsertItem(review, column, itemId, (item) => ({
        ...item,
        reflection_qas: syncQaOrder(item.reflection_qas.map((qa) => (qa.id === qaId ? { ...qa, showAnswer: true } : qa)))
      }))
    );
    pendingFocusRef.current = { type: "qa", column, itemId, qaId, field: "answer" };
  };

  const handleAddQa = (column: LogColumn, itemId: string) => {
    const nextQa = buildQaPair();
    updateCurrentReview((review) =>
      upsertItem(review, column, itemId, (item) => ({
        ...item,
        reflection_qas: syncQaOrder([...item.reflection_qas, { ...nextQa, order_index: item.reflection_qas.length }])
      }))
    );
    pendingFocusRef.current = { type: "qa", column, itemId, qaId: nextQa.id, field: "question" };
  };

  const handleDeleteReflection = (column: LogColumn, itemId: string) => {
    updateCurrentReview((review) => upsertItem(review, column, itemId, (item) => ({ ...item, reflection_qas: [] })));
    setExpandedItemIds((prev) => ({ ...prev, [itemId]: false }));
  };

  const handleRemoveQa = (column: LogColumn, itemId: string, qaId: string) => {
    updateCurrentReview((review) =>
      upsertItem(review, column, itemId, (item) => ({ ...item, reflection_qas: syncQaOrder(item.reflection_qas.filter((qa) => qa.id !== qaId)) }))
    );
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!supportsObsidianSync()) { setObsidianStatus("unsupported"); return; }
    void loadDirectoryHandle().then(async (handle) => {
      if (!handle) return;
      obsidianDirectoryRef.current = handle;
      setObsidianStatus((await hasWritePermission(handle)) ? "connected" : "permission");
    }).catch((error) => {
      console.error("Obsidian folder restore failed", error);
      setObsidianStatus("error");
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(LANG_KEY);
    if (raw === "zh" || raw === "en") setLang(raw);

    const weeklyRaw = window.localStorage.getItem(WEEKLY_SUMMARY_KEY);
    if (weeklyRaw) {
      try {
        const parsed = JSON.parse(weeklyRaw) as Record<string, WeeklySummaryState>;
        const migrated = Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => [key.includes(":") ? key : weeklySummaryKey(key, "zh"), value])
        );
        setWeeklySummaries(migrated);
      } catch (error) {
        console.error("Weekly summary cache read failed", error);
      }
    }

    const syncWeeklySummaries = async () => {
      try {
        const response = await fetch("/api/weekly-summary");
        if (!response.ok) throw new Error("Weekly summary read failed");
        const data = (await response.json()) as {
          summaries?: Array<{
            weekEnd: string;
            language: Lang;
            summary: string;
            fingerprint?: string;
          }>;
        };
        const remote = Object.fromEntries(
          (data.summaries ?? []).map((item) => [
            weeklySummaryKey(item.weekEnd, item.language),
            { status: "ready" as const, summary: item.summary, fingerprint: item.fingerprint }
          ])
        );
        setWeeklySummaries((previous) => ({ ...previous, ...remote }));
      } catch (error) {
        console.error("Weekly summary sync failed", error);
      }
    };

    void syncWeeklySummaries();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LANG_KEY, lang);
  }, [lang]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const cache = Object.fromEntries(
      Object.entries(weeklySummaries).filter(([, value]) => value.status === "ready")
    );
    window.localStorage.setItem(WEEKLY_SUMMARY_KEY, JSON.stringify(cache));
  }, [weeklySummaries]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const stored = loadLocalReviews();
    hydrateReviewList(stored);
    setStatus("saved");

    const syncRemote = async () => {
      try {
        const response = await fetch("/api/reviews");
        if (!response.ok) throw new Error("Supabase read failed");
        const data = (await response.json()) as { reviews: ReviewRecord[] };
        if (Array.isArray(data?.reviews)) {
          const remote = data.reviews.map(normalizeReview);
          const local = latestReviews.current;
          hydrateReviewList(mergeReviewsByDate(local, remote));
          setStatus("saved");
        }
      } catch (error) {
        console.error("Supabase read failed", error);
      }
    };

    void syncRemote();
  }, []);

  useEffect(() => {
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  useEffect(() => { currentIdRef.current = currentId; }, [currentId]);
  useEffect(() => { latestReviews.current = reviews; }, [reviews]);

  useEffect(() => {
    if (currentWeeklyEnd) void generateWeeklyReview(currentWeeklyEnd);
    // A saved summary is immutable until the explicit regenerate action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWeeklyEnd, lang]);

  useEffect(() => {
    if (!reviews.length) return;
    const monthKeys = Array.from(new Set(reviews.map((review) => review.date.slice(0, 7))));
    setMonthCollapseState((state) =>
      reconcileMonthCollapseState({
        monthKeys,
        currentMonth: todayKey().slice(0, 7),
        state
      })
    );
  }, [reviews]);

  useEffect(() => {
    document.querySelectorAll<HTMLTextAreaElement>("textarea[data-autoresize]").forEach(adjustTextAreaHeight);
  }, [reviews, expandedItemIds, currentId]);

  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    const selector =
      pending.type === "item"
        ? `[data-column="${pending.column}"][data-item-id="${pending.itemId}"][data-focus-kind="item"]`
        : `[data-column="${pending.column}"][data-item-id="${pending.itemId}"][data-qa-id="${pending.qaId}"][data-qa-field="${pending.field}"]`;
    const target = document.querySelector(selector) as HTMLTextAreaElement | null;
    if (target) {
      adjustTextAreaHeight(target);
      target.focus();
      target.setSelectionRange(target.value.length, target.value.length);
      pendingFocusRef.current = null;
    }
  }, [reviews]);

  const badgeClass =
    status === "saving" ? "bg-amber-100 text-amber-700" :
    status === "saved" ? "bg-emerald-100 text-emerald-900" :
    status === "error" ? "bg-rose-100 text-rose-700 hover:bg-rose-200 cursor-pointer" :
    "bg-slate-100 text-slate-600";

  const mainGridClass = isHistoryCollapsed ? "grid gap-5 lg:grid-cols-[1fr]" : "grid gap-5 lg:grid-cols-[280px_1fr]";

  const renderLogColumn = (column: LogColumn, title: string, titleClass: string, textClass: string) => {
    if (!currentReview) return null;
    const items = [...currentReview.today_log[column]].sort((a, b) => a.order_index - b.order_index);

    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className={`mb-3 text-lg font-semibold ${titleClass}`}>{title}</h3>
        <ul className={`list-disc space-y-3 pl-5 marker:text-current marker:text-xl ${textClass}`}>
          {items.map((item) => {
            const hasReflection = hasItemReflectionContent(item);
            const reflectionVisible = Boolean(expandedItemIds[item.id]);

            return (
              <li key={item.id} className="text-base">
                <div className="flex items-start gap-2">
                  <textarea
                    value={item.text}
                    onChange={(event) => {
                      adjustTextAreaHeight(event.currentTarget);
                      handleItemTextChange(column, item.id, event.target.value);
                    }}
                    onKeyDown={(event) => handleItemKeyDown(event, column, item.id)}
                    rows={1}
                    data-autoresize
                    data-column={column}
                    data-item-id={item.id}
                    data-focus-kind="item"
                    className={`min-h-[28px] flex-1 resize-none overflow-hidden border-0 bg-transparent p-0 leading-7 outline-none focus:ring-0 ${textClass}`}
                    placeholder={t.itemPlaceholder}
                  />
                  <button
                    type="button"
                    title={t.reflectDeeper}
                    className="h-7 w-7 rounded-full border border-slate-300 text-sm font-semibold text-slate-600 transition hover:border-blue-300 hover:text-blue-600"
                    onClick={() => handleToggleReflection(column, item.id)}
                  >
                    {reflectionVisible ? "-" : "+"}
                  </button>
                </div>

                {!reflectionVisible && hasReflection && (
                  <button
                    type="button"
                    className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:bg-slate-100"
                    onClick={() => handleToggleReflection(column, item.id)}
                  >
                    {t.qaSummary(item.reflection_qas.length)}
                  </button>
                )}

                {reflectionVisible && (
                  <div className="group/reflection relative mt-2 rounded-lg border border-slate-100 bg-slate-50/60 p-2 transition hover:border-slate-200">
                    <button
                      type="button"
                      className="absolute right-1.5 top-1.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full text-rose-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover/reflection:opacity-100 group-focus-within/reflection:opacity-100"
                      onClick={() => handleDeleteReflection(column, item.id)}
                      aria-label={t.deleteQa}
                      title={t.deleteQa}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 11v6" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14 11v6" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                      </svg>
                    </button>

                    <div className="flex flex-col gap-2 pr-6">
                      {[...item.reflection_qas]
                        .sort((a, b) => a.order_index - b.order_index)
                        .map((qa) => (
                          <div key={qa.id} className="group/qa relative rounded-md border border-slate-100 bg-white p-2 pr-7">
                            <button
                              type="button"
                              className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-semibold leading-none text-rose-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover/qa:opacity-100 group-focus-within/qa:opacity-100"
                              onClick={() => handleRemoveQa(column, item.id, qa.id)}
                              aria-label={t.delete}
                              title={t.delete}
                            >
                              ×
                            </button>

                            <div className="grid grid-cols-[18px,1fr] items-start gap-1.5">
                              <span className="mt-1 text-xs font-semibold text-red-600">Q:</span>
                              <textarea
                                className="min-h-[52px] w-full resize-none overflow-hidden rounded-md border border-slate-200 px-2 py-1 text-sm leading-relaxed outline-none focus:border-blue-400"
                                value={qa.question}
                                onChange={(event) => {
                                  adjustTextAreaHeight(event.currentTarget);
                                  handleQaQuestionChange(column, item.id, qa.id, event.target.value);
                                }}
                                rows={2}
                                data-autoresize
                                data-column={column}
                                data-item-id={item.id}
                                data-qa-id={qa.id}
                                data-qa-field="question"
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    handleShowAnswer(column, item.id, qa.id);
                                  }
                                }}
                                placeholder={t.qPlaceholder}
                              />
                            </div>

                            {qa.showAnswer && (
                              <div className="mt-2 grid grid-cols-[18px,1fr] items-start gap-1.5">
                                <span className="mt-1 text-xs font-semibold text-blue-600">A:</span>
                                <textarea
                                  className="min-h-[52px] w-full resize-none overflow-hidden rounded-md border border-slate-200 px-2 py-1 text-sm leading-relaxed outline-none focus:border-blue-400"
                                  value={qa.answer}
                                  onChange={(event) => {
                                    adjustTextAreaHeight(event.currentTarget);
                                    handleQaAnswerChange(column, item.id, qa.id, event.target.value);
                                  }}
                                  rows={2}
                                  data-autoresize
                                  data-column={column}
                                  data-item-id={item.id}
                                  data-qa-id={qa.id}
                                  data-qa-field="answer"
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" && !event.shiftKey) {
                                      event.preventDefault();
                                      handleAddQa(column, item.id);
                                    }
                                  }}
                                  placeholder={t.aPlaceholder}
                                />
                              </div>
                            )}
                          </div>
                        ))}

                      {item.reflection_qas.length === 0 && (
                        <button
                          type="button"
                          className="self-start rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
                          onClick={() => handleAddQa(column, item.id)}
                        >
                          {t.addFirstQa}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    );
  };

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#0f172a]">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-6 py-6">
        <header className="flex flex-col gap-1">
          <p className="text-xs uppercase tracking-[0.3em] text-slate-500">{t.topTag}</p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold leading-tight">{t.title}</h1>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${obsidianStatus === "synced" || obsidianStatus === "connected" ? "border-violet-200 bg-violet-50 text-violet-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                onClick={() => void handleObsidianConnect()}
                disabled={obsidianStatus === "syncing" || obsidianStatus === "unsupported"}
                title={t.obsidian[obsidianStatus]}
              >
                {obsidianStatus === "connected" || obsidianStatus === "synced"
                  ? t.changeObsidianFolder
                  : t.obsidian[obsidianStatus]}
              </button>
              <button
                type="button"
                className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleExportMarkdown}
                disabled={!reviews.length}
              >
                {t.exportMarkdown}
              </button>
              <div className="inline-flex rounded-full border border-slate-200 bg-white p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setLang("zh")}
                  className={`rounded-full px-2.5 py-1 transition ${lang === "zh" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                >
                  {t.langZh}
                </button>
                <button
                  type="button"
                  onClick={() => setLang("en")}
                  className={`rounded-full px-2.5 py-1 transition ${lang === "en" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                >
                  {t.langEn}
                </button>
              </div>
              <span
                className={`rounded-full px-3 py-0.5 text-xs font-semibold ${badgeClass}`}
                onClick={status === "error" ? () => void persistNow() : undefined}
              >
                {t.status[status]}
              </span>
            </div>
          </div>
        </header>

        <main className={mainGridClass}>
          {!isHistoryCollapsed && (
            <section className="rounded-2xl bg-white p-5 shadow-lg shadow-slate-200">
              <div className="mb-4 flex items-center justify-between">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-500 px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-blue-200 transition hover:from-blue-500 hover:to-indigo-400"
                  onClick={() => {
                    const input = dateInputRef.current;
                    if (!input) return;
                    try {
                      (input as HTMLInputElement & { showPicker(): void }).showPicker();
                    } catch {
                      input.click();
                    }
                  }}
                >
                  <span className="text-base leading-none">+</span>
                  <span>{t.newToday}</span>
                </button>
                <input
                  ref={dateInputRef}
                  type="date"
                  className="sr-only"
                  onChange={handleDateSelect}
                />
                <button
                  type="button"
                  className="rounded-xl border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
                  onClick={() => setIsHistoryCollapsed(true)}
                >
                  {t.collapse}
                </button>
              </div>

              <div className="flex max-h-[calc(100vh-15rem)] flex-col gap-3 overflow-y-auto overscroll-contain pr-1">
                {groupedReviews.map(([monthKey, monthReviews]) => {
                  const isCollapsed = collapsedMonths.has(monthKey);
                  return (
                    <div key={monthKey} className="flex flex-col gap-1.5">
                      <button
                        type="button"
                        onClick={() => toggleMonth(monthKey)}
                        className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-100 px-3 py-2 text-left transition hover:border-slate-300 hover:bg-slate-200"
                      >
                        <span className="text-sm font-semibold text-slate-700">{formatMonthLabel(monthKey)}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-500">{monthReviews.length}</span>
                          <span className="text-xs text-slate-500">{isCollapsed ? "▶" : "▼"}</span>
                        </div>
                      </button>

                      {!isCollapsed && (
                        <div className="flex flex-col gap-1.5 pl-2">
                          {monthReviews.map((review) => (
                            <Fragment key={review.id}>
                            {isSunday(review.date) && (
                              <button
                                type="button"
                                onClick={() => selectWeeklyReview(review.date)}
                                className={`ml-3 rounded-xl border p-2.5 text-left transition ${currentWeeklyEnd === review.date ? "border-violet-400 bg-violet-50" : "border-violet-200 bg-violet-50/50 hover:border-violet-300 hover:bg-violet-50"}`}
                              >
                                <div className="text-sm font-semibold text-violet-700">✨ {t.weeklyReview}</div>
                                <div className="mt-0.5 text-xs text-slate-500">{t.weeklyRange(weekStartKey(review.date), review.date)}</div>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => selectDailyReview(review.id)}
                              className={`rounded-xl border p-2.5 text-left transition ${review.id === currentId ? "border-blue-400 bg-blue-50" : "border-slate-200 bg-slate-50 hover:border-slate-300"}`}
                            >
                              <div className="text-sm font-semibold">{formatHistoryDate(review.date)}</div>
                              <div className="mt-0.5 text-xs text-slate-500">
                                {t.updatedAt}{" "}
                                {new Date(review.updated_at).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}
                              </div>
                            </button>
                            </Fragment>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="flex min-h-[560px] flex-col gap-4 rounded-2xl bg-white p-6 shadow-lg shadow-slate-200">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-semibold">
                  {currentWeeklyEnd
                    ? `${t.weeklyReview} · ${t.weeklyRange(weekStartKey(currentWeeklyEnd), currentWeeklyEnd)}`
                    : currentReview
                    ? formatHeaderDate(currentReview.date)
                    : t.emptyRecord}
                </p>
                <p className="text-sm text-slate-500">{currentWeeklyEnd ? "AI Summary" : t.autosaveHint}</p>
              </div>
              <div className="flex items-center gap-2">
                {currentReview && (
                  <button
                    type="button"
                    className="rounded-full border border-rose-200 px-3 py-1 text-xs font-medium text-rose-600 transition hover:border-rose-300 hover:bg-rose-50"
                    onClick={handleDeleteCurrentReview}
                  >
                    {t.deleteDay}
                  </button>
                )}
                <button
                  type="button"
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
                  onClick={() => setIsHistoryCollapsed((prev) => !prev)}
                >
                  {isHistoryCollapsed ? t.expandHistory : t.collapseHistory}
                </button>
              </div>
            </div>

            {!currentReview && !currentWeeklyEnd && <p className="text-sm text-slate-500">{t.emptyTip}</p>}

            {currentWeeklyEnd && (() => {
              const weekly = weeklySummaries[weeklySummaryKey(currentWeeklyEnd, lang)] ?? { status: "idle" as const };
              return (
                <section className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-6">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h2 className="text-xl font-semibold text-violet-800">{t.weeklyReview}</h2>
                    {weekly.status === "ready" && weekly.summary && (
                      <button
                        type="button"
                        className="rounded-full border border-violet-200 bg-white px-3 py-1 text-xs font-medium text-violet-700 transition hover:bg-violet-50"
                        onClick={() => void generateWeeklyReview(currentWeeklyEnd, true)}
                      >
                        {t.regenerateWeekly}
                      </button>
                    )}
                  </div>
                  {weekly.status === "loading" && <p className="animate-pulse text-sm text-violet-700">{t.weeklyLoading}</p>}
                  {weekly.status === "ready" && weekly.summary && (
                    <div className="grid gap-4 lg:grid-cols-2">
                      {parseWeeklySummary(weekly.summary).map((section, sectionIndex) => {
                        const theme = weeklySectionTheme(section.title);
                        return (
                          <article key={`${section.title}-${sectionIndex}`} className={`rounded-2xl border p-5 shadow-sm ${theme.card}`}>
                            <div className="mb-4 flex items-center gap-3">
                              <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${theme.iconClass}`}>
                                {theme.icon}
                              </span>
                              <h3 className={`text-base font-bold tracking-tight ${theme.titleClass}`}>{section.title}</h3>
                            </div>
                            {section.items.length ? (
                              <div className="space-y-3">
                                {section.items.map((item, itemIndex) => (
                                  <div key={itemIndex} className="flex items-start gap-3 rounded-xl bg-white/80 px-3.5 py-3 text-[15px] leading-6 text-slate-700 shadow-sm ring-1 ring-black/[0.04]">
                                    <span className={`mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-bold ${theme.iconClass}`}>
                                      {item.ordered ? itemIndex + 1 : "•"}
                                    </span>
                                    <p>{renderInlineMarkdown(item.text)}</p>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-sm text-slate-500">—</p>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  )}
                  {weekly.status === "ready" && !weekly.summary && <p className="text-sm text-slate-500">{t.weeklyEmpty}</p>}
                  {weekly.status === "error" && (
                    <div className="flex flex-wrap items-center gap-3 text-sm text-rose-600">
                      <span>{t.weeklyError}: {weekly.error}</span>
                      <button
                        type="button"
                        className="rounded-full border border-rose-200 bg-white px-3 py-1 text-xs font-medium transition hover:bg-rose-50"
                        onClick={() => void generateWeeklyReview(currentWeeklyEnd, true)}
                      >
                        {t.retryWeekly}
                      </button>
                    </div>
                  )}
                  {weekly.status === "idle" && (
                    <button
                      type="button"
                      className="rounded-full bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500"
                      onClick={() => void generateWeeklyReview(currentWeeklyEnd)}
                    >
                      {t.weeklyReview}
                    </button>
                  )}
                </section>
              );
            })()}

            {currentReview && (
              <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-xl font-semibold text-slate-800">{t.todayLog}</h2>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {renderLogColumn("red", t.redBoard, "text-red-600", "text-red-600")}
                  {renderLogColumn("black", t.blackBoard, "text-slate-900", "text-slate-900")}
                </div>
              </section>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
