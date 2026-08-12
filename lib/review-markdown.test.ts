import assert from "node:assert/strict";
import test from "node:test";

import { reviewsToMarkdown } from "./review-markdown.ts";
import { ReviewRecord } from "./review.ts";

test("exports reviews as markdown in descending date order with reflections", () => {
  const makeReview = (date: string, text: string): ReviewRecord => ({
    id: date,
    date,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    today_log: {
      red: [{ id: "r", text, order_index: 0, reflection_qas: [{ id: "q", question: "为什么？", answer: "因为专注", showAnswer: true, order_index: 0 }] }],
      black: [{ id: "b", text: "", order_index: 0, reflection_qas: [] }]
    }
  });

  const markdown = reviewsToMarkdown([makeReview("2026-08-01", "较早"), makeReview("2026-08-02", "完成目标")]);

  assert.ok(markdown.indexOf("## 2026-08-02") < markdown.indexOf("## 2026-08-01"));
  assert.match(markdown, /1\. 完成目标/);
  assert.match(markdown, /\*\*问：\*\* 为什么？/);
  assert.match(markdown, /\*\*答：\*\* 因为专注/);
  assert.match(markdown, /### 黑榜\n\n_暂无记录_/);
});

