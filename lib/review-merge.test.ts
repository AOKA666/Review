import assert from "node:assert/strict";
import test from "node:test";

import { mergeReviewsByDate } from "./review-merge.ts";
import { ReviewRecord } from "./review.ts";

const review = (date: string, updated_at: string, text: string): ReviewRecord => ({
  id: `${date}-${text}`,
  date,
  created_at: updated_at,
  updated_at,
  today_log: {
    red: [{ id: "red", text, order_index: 0, reflection_qas: [] }],
    black: []
  }
});

test("keeps the newer copy of a review when local and remote data are merged", () => {
  const local = review("2026-08-12", "2026-08-12T10:02:00Z", "本地新内容");
  const remote = review("2026-08-12", "2026-08-12T10:01:00Z", "云端旧内容");

  assert.equal(mergeReviewsByDate([local], [remote])[0].today_log.red[0].text, "本地新内容");
  assert.equal(mergeReviewsByDate([remote], [local])[0].today_log.red[0].text, "本地新内容");
});

