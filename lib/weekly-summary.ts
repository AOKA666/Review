export type WeeklySummarySection = {
  title: string;
  items: Array<{ text: string; ordered: boolean }>;
};

const headingPattern = /(红榜|黑榜|关键规律|下周行动|red.list|black.list|key patterns|next.week actions)/i;
const documentTitlePattern = /^(周复盘(?:总结)?|weekly review)(?:\s*(?:[（(].*[）)]|[·~～—–\-:：].*))?$/i;

export const parseWeeklySummary = (summary: string): WeeklySummarySection[] => {
  const sections: WeeklySummarySection[] = [];
  let current: WeeklySummarySection | null = null;

  for (const rawLine of summary.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const cleaned = line
      .replace(/^#{1,6}\s*/, "")
      .replace(/^\*\*(.*?)\*\*:?$/, "$1")
      .replace(/^[一二三四][、.]\s*/, "")
      .trim();

    if (documentTitlePattern.test(cleaned)) continue;

    if (headingPattern.test(cleaned) && !/^[-*•]|^\d+[.)、]/.test(line)) {
      current = { title: cleaned.replace(/[：:]$/, ""), items: [] };
      sections.push(current);
      continue;
    }

    // Ignore document titles and other preamble. Only the four requested
    // summary sections should be rendered as cards.
    if (!current) continue;

    const ordered = /^\d+[.)、]\s*/.test(line);
    const text = line.replace(/^[-*•]\s*/, "").replace(/^\d+[.)、]\s*/, "").trim();
    if (text) current.items.push({ text, ordered });
  }

  return sections;
};
