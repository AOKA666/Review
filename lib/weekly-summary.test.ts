import assert from "node:assert/strict";
import test from "node:test";

import { parseWeeklySummary } from "./weekly-summary.ts";

test("ignores a generated weekly review title with a parenthesized date range", () => {
  const summary = `# 周复盘（2026-06-29 ~ 2026-07-05）

## 本周红榜
- 完成重点工作

## 本周黑榜
- 睡眠不足

## 关键规律
- 提前规划更容易完成

## 下周行动
1. 每晚提前安排次日任务`;

  const sections = parseWeeklySummary(summary);

  assert.equal(sections.length, 4);
  assert.deepEqual(
    sections.map((section) => section.title),
    ["本周红榜", "本周黑榜", "关键规律", "下周行动"]
  );
});
