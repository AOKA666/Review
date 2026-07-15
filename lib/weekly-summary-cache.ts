export type WeeklySummaryStatus = "idle" | "loading" | "ready" | "error";

export type WeeklySummaryState = {
  status: WeeklySummaryStatus;
  summary?: string;
  fingerprint?: string;
  error?: string;
};

export type WeeklySummaryLanguage = "zh" | "en";

export const weeklySummaryKey = (weekEnd: string, language: WeeklySummaryLanguage) =>
  `${weekEnd}:${language}`;

export const shouldGenerateWeeklySummary = (
  cached: Pick<WeeklySummaryState, "status" | "summary"> | undefined,
  force: boolean
) => force || cached?.status !== "ready" || !cached.summary;
