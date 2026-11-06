import { LogItem, QaPair, ReviewRecord } from "./review";

const hasQaText = (qa: QaPair) => Boolean(qa.question.trim() || qa.answer.trim());

export const meaningfulQas = (qas: QaPair[] | undefined) => (qas ?? []).filter(hasQaText);

export const meaningfulItems = (items: LogItem[] | undefined) =>
  (items ?? []).filter((item) => item.text.trim() || meaningfulQas(item.reflection_qas).length > 0);

export const sortReviews = (list: ReviewRecord[]) => [...list].sort((a, b) => b.date.localeCompare(a.date));

export const stripEmptyItems = (review: ReviewRecord): ReviewRecord => ({
  ...review,
  today_log: {
    red: meaningfulItems(review.today_log?.red),
    black: meaningfulItems(review.today_log?.black)
  }
});

const qaSignature = (qa: QaPair) => [qa.question, qa.answer, qa.showAnswer];

export const contentSignature = (review: ReviewRecord) =>
  JSON.stringify({
    red: meaningfulItems(review.today_log?.red).map((item) => [item.text, meaningfulQas(item.reflection_qas).map(qaSignature)]),
    black: meaningfulItems(review.today_log?.black).map((item) => [item.text, meaningfulQas(item.reflection_qas).map(qaSignature)])
  });

const reindexQas = (qas: QaPair[]) => qas.map((qa, index) => ({ ...qa, order_index: index }));

const unionQas = (localQas: QaPair[], remoteQas: QaPair[]) => {
  const result = meaningfulQas(localQas).map((qa) => ({ ...qa }));
  const byId = new Map(result.map((qa) => [qa.id, qa]));
  for (const qa of meaningfulQas(remoteQas)) {
    const existing = byId.get(qa.id);
    if (!existing) {
      result.push({ ...qa });
      byId.set(qa.id, qa);
      continue;
    }
    if (existing.question === qa.question && existing.answer === qa.answer && existing.showAnswer === qa.showAnswer) {
      continue;
    }
    const copyId = `${qa.id}:remote-copy`;
    if (!byId.has(copyId)) {
      const copy = { ...qa, id: copyId };
      result.push(copy);
      byId.set(copyId, copy);
    }
  }
  return reindexQas(result);
};

const unionItems = (localItems: LogItem[], remoteItems: LogItem[]) => {
  const result = meaningfulItems(localItems).map((item) => ({
    ...item,
    reflection_qas: meaningfulQas(item.reflection_qas)
  }));
  const byId = new Map(result.map((item) => [item.id, item]));
  for (const item of meaningfulItems(remoteItems)) {
    const existing = byId.get(item.id);
    if (!existing) {
      const added = { ...item, reflection_qas: meaningfulQas(item.reflection_qas) };
      result.push(added);
      byId.set(item.id, added);
      continue;
    }
    if (existing.text === item.text) {
      existing.reflection_qas = unionQas(existing.reflection_qas, item.reflection_qas);
      continue;
    }
    const copyId = `${item.id}:remote-copy`;
    if (!byId.has(copyId)) {
      const copy = { ...item, id: copyId, reflection_qas: meaningfulQas(item.reflection_qas) };
      result.push(copy);
      byId.set(copyId, copy);
    }
  }
  return result.map((item, index) => ({ ...item, order_index: index }));
};

/** Keep both sides of a diverged day. Same id with different text becomes two items. */
export const preserveBoth = (local: ReviewRecord, remote: ReviewRecord): ReviewRecord => ({
  id: remote.id || local.id,
  date: local.date || remote.date,
  created_at: local.created_at || remote.created_at,
  updated_at: local.updated_at > remote.updated_at ? local.updated_at : remote.updated_at,
  today_log: {
    red: unionItems(local.today_log?.red ?? [], remote.today_log?.red ?? []),
    black: unionItems(local.today_log?.black ?? [], remote.today_log?.black ?? [])
  }
});
