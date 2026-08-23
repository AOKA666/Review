type ReviewIdentity = {
  id: string;
  date: string;
  created_at: string;
  updated_at: string;
};

type ExistingJournal = {
  id: string;
  journal_date: string;
};

type BuildJournalUpsertRowsInput = {
  owner: string;
  reviews: ReviewIdentity[];
  existing: ExistingJournal[];
};

export const buildJournalUpsertRows = ({
  owner,
  reviews,
  existing
}: BuildJournalUpsertRowsInput) => {
  const databaseIdByDate = new Map(
    existing.map((journal) => [journal.journal_date, journal.id])
  );

  return reviews.map((review) => ({
    id: databaseIdByDate.get(review.date) ?? review.id,
    owner,
    journal_date: review.date,
    created_at: review.created_at,
    updated_at: review.updated_at
  }));
};
