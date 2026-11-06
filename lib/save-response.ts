import { ReviewRecord } from "./review";
import { stripEmptyItems } from "./review-content";

export type RemoteSuccess = {
  ok: true;
  savedDates: string[];
  deletedDates: string[];
  updatedAtByDate: Record<string, string>;
};

export type RemoteConflict = {
  ok: false;
  error: "conflict";
  conflicts: Array<{ date: string; review: ReviewRecord }>;
};

export type RemoteFailure = {
  ok: false;
  error: string;
};

export type RemoteOutcome = RemoteSuccess | RemoteConflict | RemoteFailure;

export type SaveRequest = {
  reviews: ReviewRecord[];
  deletedDates: string[];
  baseUpdatedAt: Record<string, string | null>;
  dateVersions: Record<string, number>;
};

const stringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isConflictReview = (value: unknown): value is ReviewRecord => {
  if (!isRecord(value) || typeof value.date !== "string" || typeof value.id !== "string") return false;
  if (!isRecord(value.today_log)) return false;
  return Array.isArray(value.today_log.red) && Array.isArray(value.today_log.black);
};

export const interpretSaveHttp = (status: number, text: string): RemoteOutcome => {
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  const record = isRecord(body) ? body : null;
  const errorCode = record && typeof record.error === "string" ? record.error : "";

  if (status === 409 && record?.ok === false && errorCode === "conflict" && Array.isArray(record.conflicts)) {
    const conflicts = record.conflicts.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.date !== "string" || !isConflictReview(entry.review)) return [];
      return [{ date: entry.date, review: entry.review }];
    });
    return { ok: false, error: "conflict", conflicts };
  }

  if (!record || record.ok !== true || status < 200 || status >= 300) {
    return { ok: false, error: errorCode || "save_failed" };
  }

  const updatedAtByDate: Record<string, string> = {};
  if (isRecord(record.updatedAtByDate)) {
    for (const [date, value] of Object.entries(record.updatedAtByDate)) {
      if (typeof value === "string") updatedAtByDate[date] = value;
    }
  }

  return {
    ok: true,
    savedDates: stringList(record.savedDates),
    deletedDates: stringList(record.deletedDates),
    updatedAtByDate
  };
};

export const postReviewSave = async (
  request: SaveRequest,
  fetchImpl: typeof fetch = fetch
): Promise<RemoteOutcome> => {
  const response = await fetchImpl("/api/reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reviews: request.reviews.map(stripEmptyItems),
      deletedDates: request.deletedDates,
      baseUpdatedAt: request.baseUpdatedAt
    })
  });
  return interpretSaveHttp(response.status, await response.text());
};

export const fetchRemoteReviews = async (fetchImpl: typeof fetch = fetch): Promise<ReviewRecord[]> => {
  const response = await fetchImpl("/api/reviews");
  const text = await response.text();
  if (!response.ok) throw new Error("reviews_read_failed");
  const body = text ? JSON.parse(text) as { reviews?: unknown } : {};
  if (!Array.isArray(body.reviews)) throw new Error("reviews_read_failed");
  return body.reviews as ReviewRecord[];
};
