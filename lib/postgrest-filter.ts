const JOURNAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FILTER_TOKEN = /^[A-Za-z0-9:._-]+$/;

const unique = (values: readonly string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

export class PostgrestFilterError extends Error {
  constructor(readonly code: "invalid_journal_date" | "invalid_filter_token" | "empty_in_list") {
    super(code);
    this.name = "PostgrestFilterError";
  }
}

export const assertJournalDates = (dates: readonly string[]) => {
  const result = unique(dates);
  for (const date of result) {
    if (!JOURNAL_DATE.test(date)) throw new PostgrestFilterError("invalid_journal_date");
  }
  return result;
};

/**
 * Value for PostgREST `in` / `not.in`. supabase-js `.not(column, "in", array)`
 * stringifies the array without parentheses and PostgREST returns PGRST100
 * (`failed to parse filter (not.in.2026-11-06,...)`). Callers must pass this
 * parenthesized list through `.not(column, "in", value)` or `.filter`.
 */
export const buildJournalDateInFilterValue = (dates: readonly string[]) => {
  const uniqueDates = assertJournalDates(dates);
  if (uniqueDates.length === 0) throw new PostgrestFilterError("empty_in_list");
  return `(${uniqueDates.join(",")})`;
};

export const buildIdInFilterValue = (ids: readonly string[]) => {
  const uniqueIds = unique(ids);
  if (uniqueIds.length === 0) throw new PostgrestFilterError("empty_in_list");
  for (const id of uniqueIds) {
    if (!FILTER_TOKEN.test(id)) throw new PostgrestFilterError("invalid_filter_token");
  }
  return `(${uniqueIds.join(",")})`;
};

export const journalDateNotInFilter = (dates: readonly string[]) =>
  `not.in.${buildJournalDateInFilterValue(dates)}`;
