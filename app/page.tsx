"use client";

import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { LogItem, QaPair, ReviewRecord, TodayLog } from "../lib/review";

type SaveStatus = "ready" | "saving" | "saved" | "error";
type LogColumn = "red" | "black";
type Lang = "zh" | "en";

const STORAGE_KEY = "repano_reviews";
const LANG_KEY = "repano_lang";
const MAX_HISTORY = 20;

const i18n = {
  zh: {
    topTag: "今日记录",
    title: "复盘日志",
    status: { ready: "就绪", saving: "保存中...", saved: "已保存", error: "保存失败（点击重试）" },
    langZh: "中文",
    langEn: "EN",
    newToday: "新建今日记录",
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
    qaSummary: (count: number) => `已记录 ${count} 轮 QA，点击展开`,
    deleteQa: "删除 QA",
    qPlaceholder: "输入问题，回车进入回答",
    aPlaceholder: "输入回答，回车新增下一轮",
    delete: "删除",
    addFirstQa: "+ 新增第一轮 QA"
  },
  en: {
    topTag: "Today Log",
    title: "Review Log",
    status: { ready: "Ready", saving: "Saving...", saved: "Saved", error: "Save failed (click to retry)" },
    langZh: "中文",
    langEn: "EN",
    newToday: "New today entry",
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
    qaSummary: (count: number) => `${count} QA rounds recorded, click to expand`,
    deleteQa: "Delete QA",
    qPlaceholder: "Type your question, Enter to answer",
    aPlaceholder: "Type your answer, Enter for next round",
    delete: "Delete",
    addFirstQa: "+ Add first QA round"
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

const sortAndLimit = (list: ReviewRecord[]) => [...list].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_HISTORY);
const hasItemReflectionContent = (item: LogItem) => item.reflection_qas.some((qa) => qa.question.trim() || qa.answer.trim());

export default function HomePage() {
  const [lang, setLang] = useState<Lang>("zh");
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("ready");
  const [isHistoryCollapsed, setIsHistoryCollapsed] = useState(false);
  const [expandedItemIds, setExpandedItemIds] = useState<Record<string, boolean>>({});

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestReviews = useRef<ReviewRecord[]>([]);
  const currentIdRef = useRef<string | null>(null);
  const pendingFocusRef = useRef<{ column: LogColumn; itemId: string } | null>(null);

  const t = i18n[lang];
  const formatHeaderDate = (dateStr: string) => {
    const date = new Date(dateStr);
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

  const setReviewsDirect = (next: ReviewRecord[]) => {
    const sorted = sortAndLimit(next.map(normalizeReview));
    latestReviews.current = sorted;
    setReviews(sorted);
  };

  const updateReviews = (updater: (prev: ReviewRecord[]) => ReviewRecord[]) => {
    setReviews((prev) => {
      const updated = updater(prev);
      const sorted = sortAndLimit(updated.map(normalizeReview));
      latestReviews.current = sorted;
      return sorted;
    });
  };

  const persistLocally = (list: ReviewRecord[]) => {
    if (typeof window === "undefined") return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sortAndLimit(list))); }
    catch (error) { console.error("Local save failed", error); setStatus("error"); }
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
  const persistNow = async () => {
    if (typeof window === "undefined") return;
    if (!latestReviews.current.length) return;

    const now = new Date().toISOString();
    const updated = latestReviews.current.map((review) =>
      review.id === currentIdRef.current ? { ...review, updated_at: now } : review
    );
    const payload = sortAndLimit(updated);

    setReviewsDirect(payload);
    persistLocally(payload);

    try { await saveToSupabase(payload); setStatus("saved"); }
    catch (error) { console.error("Supabase write failed", error); setStatus("error"); }
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
    const normalized = sortAndLimit(source.map(normalizeReview));
    const today = todayKey();
    const todayReview = normalized.find((item) => item.date === today);

    if (todayReview) {
      setReviewsDirect(normalized);
      setCurrentId(todayReview.id);
      persistLocally(normalized);
      return;
    }

    const next = [buildReview(today), ...normalized].slice(0, MAX_HISTORY);
    setReviewsDirect(next);
    setCurrentId(next[0]?.id ?? null);
    persistLocally(next);
  };

  const handleNewReview = () => {
    const today = todayKey();
    const existed = reviews.find((item) => item.date === today);
    if (existed) { setCurrentId(existed.id); return; }

    const next = [buildReview(today), ...reviews].slice(0, MAX_HISTORY);
    setReviewsDirect(next);
    setCurrentId(next[0]?.id ?? null);
    setStatus("saved");
    void persistNow();
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
      try { await saveToSupabase(sortAndLimit(nextList)); setStatus("saved"); }
      catch (error) { console.error("Supabase delete sync failed", error); setStatus("error"); }
    })();
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
      list.splice(index + 1, 0, buildLogItem(list.length));
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
      if (fallback) pendingFocusRef.current = { column, itemId: fallback.id };

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
  };

  const handleAddQa = (column: LogColumn, itemId: string) => {
    updateCurrentReview((review) =>
      upsertItem(review, column, itemId, (item) => ({
        ...item,
        reflection_qas: syncQaOrder([...item.reflection_qas, buildQaPair(item.reflection_qas.length)])
      }))
    );
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
    const raw = window.localStorage.getItem(LANG_KEY);
    if (raw === "zh" || raw === "en") setLang(raw);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LANG_KEY, lang);
  }, [lang]);

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
          hydrateReviewList(data.reviews.map(normalizeReview));
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
    const pending = pendingFocusRef.current;
    if (!pending) return;
    const target = document.querySelector(`[data-column="${pending.column}"][data-item-id="${pending.itemId}"]`) as HTMLTextAreaElement | null;
    if (target) {
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
                    onChange={(event) => handleItemTextChange(column, item.id, event.target.value)}
                    onKeyDown={(event) => handleItemKeyDown(event, column, item.id)}
                    data-column={column}
                    data-item-id={item.id}
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
                  <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-rose-500 transition hover:bg-rose-50 hover:text-rose-600"
                        onClick={() => handleDeleteReflection(column, item.id)}
                        aria-label={t.deleteQa}
                        title={t.deleteQa}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M10 11v6" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14 11v6" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        </svg>
                      </button>
                    </div>

                    <div className="flex flex-col gap-2">
                      {[...item.reflection_qas]
                        .sort((a, b) => a.order_index - b.order_index)
                        .map((qa) => (
                          <div key={qa.id} className="rounded-lg border border-dashed border-slate-200 bg-white p-2">
                            <div className="flex items-start gap-2">
                              <span className="mt-1 text-xs font-semibold text-red-600">Q:</span>
                              <textarea
                                className="min-h-[52px] flex-1 rounded-md border border-slate-200 px-2 py-1 text-sm leading-relaxed outline-none focus:border-blue-400"
                                value={qa.question}
                                onChange={(event) => handleQaQuestionChange(column, item.id, qa.id, event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    handleShowAnswer(column, item.id, qa.id);
                                  }
                                }}
                                placeholder={t.qPlaceholder}
                              />
                              <button
                                type="button"
                                className="rounded-md px-2 py-1 text-xs text-rose-500 transition hover:bg-rose-50 hover:text-rose-600"
                                onClick={() => handleRemoveQa(column, item.id, qa.id)}
                              >
                                {t.delete}
                              </button>
                            </div>

                            {qa.showAnswer && (
                              <div className="mt-2 flex items-start gap-2">
                                <span className="mt-1 text-xs font-semibold text-blue-600">A:</span>
                                <textarea
                                  className="min-h-[52px] flex-1 rounded-md border border-slate-200 px-2 py-1 text-sm leading-relaxed outline-none focus:border-blue-400"
                                  value={qa.answer}
                                  onChange={(event) => handleQaAnswerChange(column, item.id, qa.id, event.target.value)}
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
                  onClick={handleNewReview}
                >
                  <span className="text-base leading-none">+</span>
                  <span>{t.newToday}</span>
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
                  onClick={() => setIsHistoryCollapsed(true)}
                >
                  {t.collapse}
                </button>
              </div>

              <div className="flex flex-col gap-2">
                {reviews.map((review) => (
                  <button
                    key={review.id}
                    type="button"
                    onClick={() => setCurrentId(review.id)}
                    className={`rounded-xl border p-3 text-left transition ${review.id === currentId ? "border-blue-400 bg-blue-50" : "border-slate-200 bg-slate-50 hover:border-slate-300"}`}
                  >
                    <div className="text-sm font-semibold">{review.date.replace(/-/g, ".")}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {t.updatedAt}{" "}
                      {new Date(review.updated_at).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="flex min-h-[560px] flex-col gap-4 rounded-2xl bg-white p-6 shadow-lg shadow-slate-200">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-semibold">{currentReview ? formatHeaderDate(currentReview.date) : t.emptyRecord}</p>
                <p className="text-sm text-slate-500">{t.autosaveHint}</p>
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

            {!currentReview && <p className="text-sm text-slate-500">{t.emptyTip}</p>}

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
