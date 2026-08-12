import { ReviewRecord } from "./review";

const timestamp = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const mergeReviewsByDate = (local: ReviewRecord[], remote: ReviewRecord[]) => {
  const merged = new Map<string, ReviewRecord>();

  for (const review of remote) merged.set(review.date, review);
  for (const review of local) {
    const existing = merged.get(review.date);
    if (!existing || timestamp(review.updated_at) >= timestamp(existing.updated_at)) {
      merged.set(review.date, review);
    }
  }

  return [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
};

