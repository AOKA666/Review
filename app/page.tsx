"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { QaPair, ReviewRecord, ReviewRow } from "../lib/review";

type SaveStatus = "ready" | "saving" | "saved" | "error" | "dirty";

const STORAGE_KEY = "repano_reviews";
const MAX_HISTORY = 20;

const statusText: Record<SaveStatus, string> = {
  ready: "准备就绪",
  saving: "保存中...",
  saved: "已保存",
  error: "保存失败（点击重试）",
  dirty: "已修改"
};

const randomId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

const todayKey = () => new Date().toISOString().slice(0, 10);

const buildQaPair = (): QaPair => ({
  id: randomId(),
  question: "",
  answer: "",
  showAnswer: false,
  order_index: 0
});

const buildDefaultRows = (): ReviewRow[] => [
  {
    id: randomId(),
    category: "学习",
    context: " ",
    solutions: " ",
    order_index: 0,
    qas: [buildQaPair()]
  },
  {
    id: randomId(),
    category: "生活",
    context: " ",
    solutions: " ",
    order_index: 1,
    qas: [buildQaPair()]
  }
];

const buildReview = (date: string): ReviewRecord => ({
  id: randomId(),
  date,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  rows: buildDefaultRows()
});

const formatHeaderDate = (dateStr: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).format(new Date(dateStr));

const sortAndLimit = (list: ReviewRecord[]) =>
  [...list]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_HISTORY);

export default function HomePage() {
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("ready");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestReviews = useRef<ReviewRecord[]>([]);
  const currentIdRef = useRef<string | null>(null);
  const [isHistoryCollapsed, setIsHistoryCollapsed] = useState(false);

  const currentReview = useMemo(
    () => reviews.find((item) => item.id === currentId) ?? null,
    [reviews, currentId]
  );

  const toggleHistoryCollapsed = () => {
    setIsHistoryCollapsed((prev) => !prev);
  };

  const setReviewsDirect = (next: ReviewRecord[]) => {
    const sorted = sortAndLimit(next);
    latestReviews.current = sorted;
    setReviews(sorted);
  };

  const updateReviews = (updater: (prev: ReviewRecord[]) => ReviewRecord[]) => {
    setReviews((prev) => {
      const updated = updater(prev);
      const sorted = sortAndLimit(updated);
      latestReviews.current = sorted;
      return sorted;
    });
  };

  const persistLocally = (list: ReviewRecord[]) => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sortAndLimit(list)));
    } catch (error) {
      console.error("保存失败", error);
      setStatus("error");
    }
  };

  const saveToSupabase = async (payload: ReviewRecord[]) => {
    const response = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviews: payload })
    });
    if (!response.ok) {
      const failure = await response.text();
      throw new Error(failure || "Supabase 写入失败");
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
    try {
      await saveToSupabase(payload);
      setStatus("saved");
    } catch (error) {
      console.error("Supabase 写入失败", error);
      setStatus("error");
    }
  };

  const loadLocalReviews = (): ReviewRecord[] => {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.error("读取本地数据失败", error);
      return [];
    }
  };

  const hydrateReviewList = (source: ReviewRecord[]) => {
    const today = todayKey();
    const todayReview = source.find((item) => item.date === today);
    if (todayReview) {
      setReviewsDirect(source);
      setCurrentId(todayReview.id);
      persistLocally(source);
      return source;
    }
    const next = [buildReview(today), ...source];
    setReviewsDirect(next);
    setCurrentId(next[0]?.id ?? null);
    persistLocally(next);
    return next;
  };

  const scheduleSave = () => {
    setStatus("saving");
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
    }
    saveTimer.current = setTimeout(() => {
      void persistNow();
    }, 1000);
  };

  const handleNewReview = () => {
    const today = todayKey();
    if (reviews[0]?.date === today) {
      setCurrentId(reviews[0].id);
      return;
    }
    const next = [buildReview(today), ...reviews.filter((item) => item.date !== today)].slice(
      0,
      MAX_HISTORY
    );
    setReviewsDirect(next);
    setCurrentId(next[0]?.id ?? null);
    setStatus("saved");
    void persistNow();
  };

  const handleDeleteCurrentReview = () => {
    if (!currentReview) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(`确认删除 ${currentReview.date} 的复盘吗？`)
    ) {
      return;
    }

    const remaining = reviews.filter((item) => item.id !== currentReview.id);
    const nextList = remaining.length ? remaining : [buildReview(todayKey())];
    const nextCurrentId = nextList[0]?.id ?? null;

    setReviewsDirect(nextList);
    setCurrentId(nextCurrentId);
    currentIdRef.current = nextCurrentId;
    persistLocally(nextList);

    setStatus("saving");
    void (async () => {
      try {
        await saveToSupabase(sortAndLimit(nextList));
        setStatus("saved");
      } catch (error) {
        console.error("Supabase 鍐欏叆澶辫触", error);
        setStatus("error");
      }
    })();
  };

  const handleRowFieldChange = (
    rowId: string,
    field: "category" | "context" | "solutions",
    value: string
  ) => {
    if (!currentId) return;
    updateReviews((prev) =>
      prev.map((review) => {
        if (review.id !== currentId) return review;
        const rows = review.rows.map((row) =>
          row.id === rowId ? { ...row, [field]: value } : row
        );
        return { ...review, rows };
      })
    );
    scheduleSave();
  };

  const handleAddRow = (afterRowId: string) => {
    if (!currentId) return;
    updateReviews((prev) =>
      prev.map((review) => {
        if (review.id !== currentId) return review;
        const index = review.rows.findIndex((row) => row.id === afterRowId);
        const newRow: ReviewRow = {
          id: randomId(),
          category: "",
          context: "- ",
          solutions: "- ",
          order_index: review.rows.length,
          qas: [buildQaPair()]
        };
        const rows = [...review.rows];
        rows.splice(index + 1, 0, newRow);
        return {
          ...review,
          rows: rows.map((row, idx) => ({ ...row, order_index: idx }))
        };
      })
    );
    scheduleSave();
  };

  const handleDeleteRow = (rowId: string) => {
    if (!currentId) return;
    const rowCount = currentReview?.rows.length ?? 0;
    if (rowCount <= 1) return;
    if (typeof window !== "undefined" && !window.confirm("确认删除这一行？")) {
      return;
    }
    updateReviews((prev) =>
      prev.map((review) => {
        if (review.id !== currentId) return review;
        const filtered = review.rows.filter((row) => row.id !== rowId);
        return {
          ...review,
          rows: filtered.map((row, idx) => ({ ...row, order_index: idx }))
        };
      })
    );
    scheduleSave();
  };

  const syncQaOrder = (qas: QaPair[]) => qas.map((qa, idx) => ({ ...qa, order_index: idx }));

  const handleQaQuestionChange = (rowId: string, qaId: string, value: string) => {
    if (!currentId) return;
    updateReviews((prev) =>
      prev.map((review) => {
        if (review.id !== currentId) return review;
        const rows = review.rows.map((row) => {
          if (row.id !== rowId) return row;
          const qas = row.qas.map((qa) => (qa.id === qaId ? { ...qa, question: value } : qa));
          return { ...row, qas };
        });
        return { ...review, rows };
      })
    );
    scheduleSave();
  };

  const handleQaAnswerChange = (rowId: string, qaId: string, value: string) => {
    if (!currentId) return;
    updateReviews((prev) =>
      prev.map((review) => {
        if (review.id !== currentId) return review;
        const rows = review.rows.map((row) => {
          if (row.id !== rowId) return row;
          const qas = row.qas.map((qa) =>
            qa.id === qaId ? { ...qa, answer: value, showAnswer: true } : qa
          );
          return { ...row, qas };
        });
        return { ...review, rows };
      })
    );
    scheduleSave();
  };

  const handleShowAnswer = (rowId: string, qaId: string) => {
    if (!currentId) return;
    updateReviews((prev) =>
      prev.map((review) => {
        if (review.id !== currentId) return review;
        const rows = review.rows.map((row) => {
          if (row.id !== rowId) return row;
          const qas = row.qas.map((qa) =>
            qa.id === qaId ? { ...qa, showAnswer: true } : qa
          );
          return { ...row, qas };
        });
        return { ...review, rows };
      })
    );
    scheduleSave();
  };

  const handleAddQa = (rowId: string) => {
    if (!currentId) return;
    updateReviews((prev) =>
      prev.map((review) => {
        if (review.id !== currentId) return review;
        const rows = review.rows.map((row) => {
          if (row.id !== rowId) return row;
          const nextQa: QaPair = { ...buildQaPair(), order_index: row.qas.length };
          return {
            ...row,
            qas: syncQaOrder([...row.qas, nextQa])
          };
        });
        return { ...review, rows };
      })
    );
    scheduleSave();
  };

  const handleRemoveQa = (rowId: string, qaId: string) => {
    if (!currentId) return;
    updateReviews((prev) =>
      prev.map((review) => {
        if (review.id !== currentId) return review;
        const rows = review.rows.map((row) => {
          if (row.id !== rowId) return row;
          const filtered = row.qas.filter((qa) => qa.id !== qaId);
          const normalized = filtered.length ? filtered : [buildQaPair()];
          return {
            ...row,
            qas: syncQaOrder(normalized)
          };
        });
        return { ...review, rows };
      })
    );
    scheduleSave();
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = loadLocalReviews();
    hydrateReviewList(stored);
    setStatus("saved");

    const syncRemote = async () => {
      try {
        const response = await fetch("/api/reviews");
        if (!response.ok) {
          throw new Error("Supabase 读取失败");
        }
        const data = (await response.json()) as { reviews: ReviewRecord[] };
        if (Array.isArray(data?.reviews)) {
          hydrateReviewList(data.reviews);
          setStatus("saved");
        }
      } catch (error) {
        console.error("Supabase 读取失败", error);
      }
    };

    void syncRemote();
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);

  useEffect(() => {
    latestReviews.current = reviews;
  }, [reviews]);

  const badgeClass =
    status === "saving"
      ? "bg-amber-100 text-amber-700"
      : status === "saved"
      ? "bg-emerald-100 text-emerald-900"
      : status === "error"
      ? "bg-rose-100 text-rose-700 hover:bg-rose-200"
      : "bg-slate-100 text-slate-600";

  const mainGridClass = isHistoryCollapsed
    ? "grid gap-8 lg:grid-cols-[1fr]"
    : "grid gap-8 lg:grid-cols-[auto_1fr]";

  const historyToggleMessage = isHistoryCollapsed
    ? "历史复盘面板已折叠，点击按钮可再次查看历史记录。"
    : "历史复盘列表正在显示，折叠后可为右侧输入争取更多空间。";

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#0f172a]">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-6 py-10">
        <header className="flex flex-col gap-1">
          <p className="text-xs uppercase tracking-[0.3em] text-slate-500">只写今日 · 每日一表</p>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="text-3xl font-semibold leading-tight">复盘日志</h1>
              <span className={`rounded-full px-4 py-1 text-sm font-semibold ${badgeClass}`} onClick={status === "error" ? () => void persistNow() : undefined}>
              {statusText[status]}
            </span>
          </div>
        </header>

        <main className={mainGridClass}>
          {!isHistoryCollapsed && (
            <section className="rounded-2xl bg-white p-8 shadow-lg shadow-slate-200">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-500 px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-blue-200 transition hover:from-blue-500 hover:to-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-400"
                    onClick={handleNewReview}
                  >
                    <span className="text-base leading-none">+</span>
                    <span className="whitespace-nowrap">新建今日复盘</span>
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-2xl border border-slate-200 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-slate-300"
                    onClick={toggleHistoryCollapsed}
                  >
                    <span className="translate-y-px text-sm leading-none">⌄</span>
                    <span>收起历史面板</span>
                  </button>
                </div>
              </div>
              <div className="flex flex-col gap-3">
              {reviews.length === 0 && (
                <p className="text-sm text-slate-500">尚未写任何复盘，点击右上角可启动今日表格。</p>
              )}
              {reviews.map((review) => (
                <button
                  key={review.id}
                  type="button"
                  onClick={() => {
                    setCurrentId(review.id);
                  }}
                  className={`text-left transition hover:border-blue-400 ${
                    review.id === currentId
                      ? "border border-blue-400 bg-blue-50"
                      : "border border-slate-200 bg-slate-50"
                  } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400`}
                >
                  <div className="flex flex-col gap-0.5 p-3">
                      <span className="text-sm font-semibold">{review.date.replace(/-/g, ".")}</span>
                    <span className="text-xs text-slate-500">
                      更新于 {new Date(review.updated_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className="text-xs text-slate-500">行数 {review.rows.length}</span>
                  </div>
                </button>
              ))}
            </div>
            <p className="mt-4 text-xs text-slate-400">历史列表按日期降序，仅展示最近 20 条。</p>
            </section>
          )}

          <section className="flex min-h-[560px] flex-col gap-4 rounded-2xl bg-white p-8 shadow-lg shadow-slate-200">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-lg font-semibold">{currentReview ? formatHeaderDate(currentReview.date) : "尚未创建复盘"}</p>
                <p className="text-sm text-slate-500">自动保存 · 失焦或 1 秒完成</p>
              </div>
              <div className="flex items-center gap-2">
                {currentReview && (
                  <button
                    type="button"
                    className="rounded-full border border-rose-200 px-3 py-1 text-xs font-medium text-rose-600 transition hover:border-rose-300 hover:bg-rose-50"
                    onClick={handleDeleteCurrentReview}
                  >
                    删除这一天
                  </button>
                )}
                <div className="rounded-full bg-slate-100 px-4 py-1 text-sm text-slate-600">
                  {currentReview ? new Date(currentReview.updated_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 text-sm text-slate-500">
              <p className="flex-1">{historyToggleMessage}</p>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
                onClick={toggleHistoryCollapsed}
                aria-expanded={!isHistoryCollapsed}
              >
                {isHistoryCollapsed ? "展开历史复盘" : "折叠历史复盘"}
              </button>
            </div>

            <div className="flex-1 overflow-hidden rounded-2xl bg-[#f8fafc] p-4">
              <div className="grid grid-cols-[120px_1fr_240px_1fr_90px] gap-4 rounded-xl border border-transparent bg-white px-4 py-2 text-sm font-semibold text-slate-500 shadow-sm">
                <span>类别</span>
                <span>今天发生的事</span>
                <span>多提几个问题</span>
                <span>解决问题</span>
                <span className="text-right">操作</span>
              </div>
              <div className="mt-4 flex flex-col gap-4">
                {!currentReview && (
                  <p className="text-sm text-slate-500">当前没有可编辑的复盘，点击「新建」开始今天的表格。</p>
                )}
                {currentReview?.rows
                  .sort((a, b) => a.order_index - b.order_index)
                  .map((row) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-[120px_1fr_240px_1fr_90px] items-start gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                    >
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-slate-400">类别</span>
                        <input
                          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                          value={row.category}
                          onChange={(event) =>
                            handleRowFieldChange(row.id, "category", event.target.value)
                          }
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-slate-400">今天发生的事</span>
                        <textarea
                          className="min-h-[80px] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-relaxed focus:border-blue-400 focus:outline-none"
                          value={row.context}
                          onChange={(event) =>
                            handleRowFieldChange(row.id, "context", event.target.value)
                          }
                        />
                      </label>
                      <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium text-slate-400">多提几个问题</span>
                        <div className="flex flex-col gap-3">
                          {[...row.qas]
                            .sort((a, b) => a.order_index - b.order_index)
                            .map((qa) => (
                              <div
                                key={qa.id}
                                className="flex flex-col gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-3"
                              >
                                <div className="flex items-start gap-2">
                                  <span className="text-xs font-semibold text-red-600 mt-1">Q:</span>
                                  <textarea
                                    className="min-h-[52px] flex-1 border-0 bg-transparent p-0 text-sm leading-relaxed outline-none focus-visible:ring-0"
                                    value={qa.question}
                                    onChange={(event) =>
                                      handleQaQuestionChange(row.id, qa.id, event.target.value)
                                    }
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter" && !event.shiftKey) {
                                        event.preventDefault();
                                        handleShowAnswer(row.id, qa.id);
                                      }
                                      if (event.key === "Escape") {
                                        event.currentTarget.blur();
                                      }
                                    }}
                                    placeholder=""
                                  />
                                </div>
                                {qa.showAnswer && (
                                  <div className="flex flex-col gap-1 pt-1">
                                    <div className="flex items-start gap-2">
                                      <span className="text-xs font-semibold text-blue-600 mt-1">A:</span>
                                      <textarea
                                        className="min-h-[52px] flex-1 border-0 bg-transparent p-0 text-sm leading-relaxed outline-none focus-visible:ring-0"
                                        value={qa.answer}
                                        onChange={(event) =>
                                          handleQaAnswerChange(row.id, qa.id, event.target.value)
                                        }
                                        onKeyDown={(event) => {
                                          if (event.key === "Enter" && !event.shiftKey) {
                                            event.preventDefault();
                                            handleAddQa(row.id);
                                          }
                                          if (event.key === "Escape") {
                                            event.currentTarget.blur();
                                          }
                                        }}
                                        placeholder=""
                                      />
                                    </div>
                                    <div className="flex justify-end">
                                      <button
                                        type="button"
                                        className="text-base font-medium text-rose-500 hover:text-rose-600"
                                        onClick={() => handleRemoveQa(row.id, qa.id)}
                                        aria-label="删除 Q/A"
                                      >
                                        🗑
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                          <button
                            type="button"
                            className="text-left text-sm font-medium text-blue-600 hover:text-blue-500"
                            onClick={() => handleAddQa(row.id)}
                          >
                            + 新增问题
                          </button>
                        </div>
                      </div>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-slate-400">解决问题</span>
                        <textarea
                          className="min-h-[80px] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-relaxed focus:border-blue-400 focus:outline-none"
                          value={row.solutions}
                          onChange={(event) =>
                            handleRowFieldChange(row.id, "solutions", event.target.value)
                          }
                        />
                      </label>
                      <div className="flex flex-col items-center justify-between gap-2">
                        <button
                          type="button"
                          className="h-9 w-9 rounded-xl border border-slate-200 bg-white text-xl font-semibold leading-none text-slate-600 transition hover:border-blue-300 hover:text-blue-600"
                          title="在下方插入一行"
                          onClick={() => handleAddRow(row.id)}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          className="h-9 w-9 rounded-xl border border-slate-200 bg-white text-xl font-semibold leading-none text-slate-600 transition hover:border-rose-300 hover:text-rose-600"
                          title="删除当前行"
                          onClick={() => handleDeleteRow(row.id)}
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
            <p className="text-xs text-slate-500">
              失焦或等待 1s 后自动保存；点击错误状态可重试。每次只写当天，刷新不会丢失。
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}
