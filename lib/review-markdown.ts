import { LogItem, ReviewRecord } from "./review";

const textOf = (value: unknown) => typeof value === "string" ? value : "";

const renderItems = (items: LogItem[] | undefined) => {
  const populated = (items ?? []).filter((item) => {
    const qas = Array.isArray(item?.reflection_qas) ? item.reflection_qas : [];
    return textOf(item?.text).trim() || qas.some((qa) => textOf(qa?.question).trim() || textOf(qa?.answer).trim());
  });

  if (!populated.length) return ["_暂无记录_", ""];

  return populated.flatMap((item, index) => {
    const lines = [`${index + 1}. ${textOf(item.text).trim() || "（未填写）"}`];
    const qas = (Array.isArray(item.reflection_qas) ? item.reflection_qas : [])
      .filter((qa) => textOf(qa?.question).trim() || textOf(qa?.answer).trim());
    for (const qa of qas) {
      lines.push(`   - **问：** ${textOf(qa.question).trim() || "（未填写）"}`);
      lines.push(`     **答：** ${textOf(qa.answer).trim() || "（未填写）"}`);
    }
    lines.push("");
    return lines;
  });
};

export const reviewsToMarkdown = (reviews: ReviewRecord[]) => {
  const sorted = [...reviews].sort((a, b) => b.date.localeCompare(a.date));
  const lines = ["# 复盘日志", ""];

  for (const review of sorted) {
    lines.push(`## ${review.date}`, "", "### 红榜", "");
    lines.push(...renderItems(review.today_log?.red));
    lines.push("### 黑榜", "");
    lines.push(...renderItems(review.today_log?.black));
  }

  return `${lines.join("\n").trimEnd()}\n`;
};

export const reviewToMarkdown = (review: ReviewRecord) => {
  const lines = [
    "---",
    `date: ${review.date}`,
    "type: daily-review",
    "tags:",
    "  - daily-review",
    "---",
    "",
    `# ${review.date} 复盘`,
    "",
    "## 红榜",
    ""
  ];
  lines.push(...renderItems(review.today_log?.red));
  lines.push("## 黑榜", "");
  lines.push(...renderItems(review.today_log?.black));
  return `${lines.join("\n").trimEnd()}\n`;
};
