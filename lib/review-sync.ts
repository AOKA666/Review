import { CloudSyncStatus } from "./cloud-sync-status";
import { contentSignature, preserveBoth, sortReviews, stripEmptyItems } from "./review-content";
import { ReviewRecord } from "./review";
import { persistWithLocalFallback } from "./save-status";
import { RemoteConflict, RemoteOutcome, SaveRequest } from "./save-response";

export type SyncState = {
  reviews: ReviewRecord[];
  dirtyDates: string[];
  deletedDates: string[];
  /** Last server `updated_at` observed for a date. `null` means the server row was observed absent. */
  baseUpdatedAt: Record<string, string | null>;
  editVersion: number;
  dateVersion: Record<string, number>;
  ackedDateVersion: Record<string, number>;
  lastFailureVersion: number | null;
  /** True only after a server ack or a read that contained no unconfirmed local additions. */
  confirmed: boolean;
};

export type FlushQueue = { running: boolean; rerun: boolean };

const CACHE_VERSION = 2;

const unique = (values: string[]) => [...new Set(values)];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isReview = (value: unknown): value is ReviewRecord =>
  isRecord(value) && typeof value.date === "string" && typeof value.id === "string";

export const emptySyncState = (): SyncState => ({
  reviews: [],
  dirtyDates: [],
  deletedDates: [],
  baseUpdatedAt: {},
  editVersion: 0,
  dateVersion: {},
  ackedDateVersion: {},
  lastFailureVersion: null,
  confirmed: false
});

export const hasUnsynced = (state: SyncState) => state.dirtyDates.length > 0 || state.deletedDates.length > 0;

const stringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const legacyState = (reviews: ReviewRecord[]): SyncState => {
  const dates = unique(reviews.map((review) => review.date));
  const dateVersion: Record<string, number> = {};
  for (const date of dates) dateVersion[date] = 1;
  return {
    reviews,
    dirtyDates: dates,
    deletedDates: [],
    baseUpdatedAt: {},
    editVersion: dates.length ? 1 : 0,
    dateVersion,
    ackedDateVersion: {},
    lastFailureVersion: null,
    confirmed: false
  };
};

export const parseSyncState = (raw: string | null): SyncState => {
  if (!raw) return emptySyncState();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return legacyState(parsed.filter(isReview));
    if (!isRecord(parsed) || !Array.isArray(parsed.reviews)) return emptySyncState();
    const reviews = parsed.reviews.filter(isReview);
    if (parsed.version !== CACHE_VERSION) return legacyState(reviews);

    const baseUpdatedAt: Record<string, string | null> = {};
    if (isRecord(parsed.baseUpdatedAt)) {
      for (const [date, value] of Object.entries(parsed.baseUpdatedAt)) {
        if (typeof value === "string" || value === null) baseUpdatedAt[date] = value;
      }
    }
    const numberMap = (value: unknown) => {
      const result: Record<string, number> = {};
      if (!isRecord(value)) return result;
      for (const [date, version] of Object.entries(value)) {
        if (typeof version === "number" && Number.isFinite(version)) result[date] = version;
      }
      return result;
    };

    return {
      reviews,
      dirtyDates: stringArray(parsed.dirtyDates),
      deletedDates: stringArray(parsed.deletedDates),
      baseUpdatedAt,
      editVersion: typeof parsed.editVersion === "number" ? parsed.editVersion : 0,
      dateVersion: numberMap(parsed.dateVersion),
      ackedDateVersion: numberMap(parsed.ackedDateVersion),
      lastFailureVersion: typeof parsed.lastFailureVersion === "number" ? parsed.lastFailureVersion : null,
      confirmed: parsed.confirmed === true
    };
  } catch {
    return emptySyncState();
  }
};

export const serializeSyncState = (state: SyncState) =>
  JSON.stringify({
    version: CACHE_VERSION,
    reviews: state.reviews,
    dirtyDates: state.dirtyDates,
    deletedDates: state.deletedDates,
    baseUpdatedAt: state.baseUpdatedAt,
    editVersion: state.editVersion,
    dateVersion: state.dateVersion,
    ackedDateVersion: state.ackedDateVersion,
    lastFailureVersion: state.lastFailureVersion,
    confirmed: state.confirmed
  });

export const ensureToday = (state: SyncState, today: string, create: () => ReviewRecord): SyncState => {
  if (state.reviews.some((review) => review.date === today)) return state;
  const review = create();
  return {
    ...state,
    reviews: sortReviews([review, ...state.reviews]),
    baseUpdatedAt: Object.hasOwn(state.baseUpdatedAt, review.date)
      ? state.baseUpdatedAt
      : { ...state.baseUpdatedAt, [review.date]: null }
  };
};

export const noteEdit = (state: SyncState, reviews: ReviewRecord[], date: string): SyncState => ({
  ...state,
  reviews: sortReviews(reviews),
  dirtyDates: unique([...state.dirtyDates.filter((item) => item !== date), date]),
  deletedDates: state.deletedDates.filter((item) => item !== date),
  editVersion: state.editVersion + 1,
  dateVersion: { ...state.dateVersion, [date]: (state.dateVersion[date] ?? 0) + 1 }
});

export const noteDelete = (state: SyncState, date: string): SyncState => {
  const observedAbsent = Object.hasOwn(state.baseUpdatedAt, date) && state.baseUpdatedAt[date] === null;
  return {
    ...state,
    reviews: state.reviews.filter((review) => review.date !== date),
    dirtyDates: state.dirtyDates.filter((item) => item !== date),
    deletedDates: observedAbsent
      ? state.deletedDates.filter((item) => item !== date)
      : unique([...state.deletedDates, date]),
    editVersion: state.editVersion + 1,
    dateVersion: { ...state.dateVersion, [date]: (state.dateVersion[date] ?? 0) + 1 }
  };
};

export const mergeRemoteSnapshot = (state: SyncState, remoteReviews: ReviewRecord[]): SyncState => {
  const remoteByDate = new Map<string, ReviewRecord>();
  for (const review of remoteReviews) {
    if (isReview(review)) remoteByDate.set(review.date, review);
  }
  const localByDate = new Map(state.reviews.map((review) => [review.date, review]));
  const dirty = new Set(state.dirtyDates);
  const deleted = new Set(state.deletedDates);
  const baseUpdatedAt = { ...state.baseUpdatedAt };
  const dates = new Set<string>([...remoteByDate.keys(), ...localByDate.keys(), ...deleted]);
  const reviews: ReviewRecord[] = [];
  const stillDirty = new Set<string>();

  for (const date of dates) {
    const remote = remoteByDate.get(date);
    const local = localByDate.get(date);
    if (deleted.has(date)) {
      if (!remote) {
        deleted.delete(date);
        baseUpdatedAt[date] = null;
        continue;
      }
      const base = Object.hasOwn(state.baseUpdatedAt, date) ? state.baseUpdatedAt[date] : null;
      if (base !== remote.updated_at) {
        deleted.delete(date);
        reviews.push(remote);
        baseUpdatedAt[date] = remote.updated_at;
        continue;
      }
      continue;
    }
    if (local && dirty.has(date)) {
      const merged = remote ? preserveBoth(local, remote) : local;
      reviews.push(merged);
      if (remote) baseUpdatedAt[date] = remote.updated_at;
      else baseUpdatedAt[date] = null;
      if (!remote || contentSignature(merged) !== contentSignature(remote)) stillDirty.add(date);
      continue;
    }
    if (remote) {
      reviews.push(remote);
      baseUpdatedAt[date] = remote.updated_at;
      continue;
    }
    if (!local) continue;
    const knownAbsent = Object.hasOwn(state.baseUpdatedAt, date) && state.baseUpdatedAt[date] === null;
    if (knownAbsent) {
      reviews.push(local);
      continue;
    }
    if (typeof state.baseUpdatedAt[date] === "string") {
      baseUpdatedAt[date] = null;
      continue;
    }
    reviews.push(local);
    baseUpdatedAt[date] = null;
    if (contentSignature(local) !== contentSignature({ ...local, today_log: { red: [], black: [] } })) {
      stillDirty.add(date);
    }
  }

  const deletedDates = [...deleted];
  return {
    ...state,
    reviews: sortReviews(reviews),
    dirtyDates: [...stillDirty],
    deletedDates,
    baseUpdatedAt,
    confirmed: stillDirty.size === 0 && deletedDates.length === 0 ? true : state.confirmed
  };
};

const inflightIsCurrent = (state: SyncState, inflight: Record<string, number>) => {
  const dates = [...state.dirtyDates, ...state.deletedDates];
  return dates.length > 0 && dates.every((date) => inflight[date] === state.dateVersion[date]);
};

export const displayStatus = (state: SyncState, inflight: Record<string, number> | null): CloudSyncStatus => {
  if (hasUnsynced(state) && inflight && inflightIsCurrent(state, inflight)) return "syncing";
  if (hasUnsynced(state) && state.lastFailureVersion === state.editVersion) return "error";
  if (hasUnsynced(state)) return "pending";
  if (state.confirmed) return "synced";
  return "ready";
};

export const buildSaveRequest = (state: SyncState): SaveRequest => {
  const dirty = new Set(state.dirtyDates);
  const reviews = sortReviews(state.reviews.filter((review) => dirty.has(review.date)).map(stripEmptyItems));
  const deletedDates = [...state.deletedDates];
  const baseUpdatedAt: Record<string, string | null> = {};
  const dateVersions: Record<string, number> = {};
  for (const date of [...reviews.map((review) => review.date), ...deletedDates]) {
    baseUpdatedAt[date] = Object.hasOwn(state.baseUpdatedAt, date) ? state.baseUpdatedAt[date] : null;
    dateVersions[date] = state.dateVersion[date] ?? 0;
  }
  return { reviews, deletedDates, baseUpdatedAt, dateVersions };
};

const acknowledgeDate = (
  state: SyncState,
  date: string,
  requestVersion: number | undefined
) => requestVersion != null && requestVersion >= (state.ackedDateVersion[date] ?? 0);

export const applyRemoteSuccess = (
  state: SyncState,
  success: { savedDates: string[]; deletedDates: string[]; updatedAtByDate: Record<string, string> },
  requestVersions: Record<string, number>
): SyncState => {
  const dirty = new Set(state.dirtyDates);
  const deleted = new Set(state.deletedDates);
  const baseUpdatedAt = { ...state.baseUpdatedAt };
  const ackedDateVersion = { ...state.ackedDateVersion };

  for (const date of success.savedDates) {
    const requestVersion = requestVersions[date];
    if (!acknowledgeDate(state, date, requestVersion)) continue;
    const updatedAt = success.updatedAtByDate[date];
    if (!updatedAt) continue;
    if (requestVersion! >= (ackedDateVersion[date] ?? 0)) baseUpdatedAt[date] = updatedAt;
    if (requestVersion === (state.dateVersion[date] ?? 0) && !deleted.has(date)) {
      dirty.delete(date);
      ackedDateVersion[date] = requestVersion;
    }
  }

  for (const date of success.deletedDates) {
    const requestVersion = requestVersions[date];
    if (!acknowledgeDate(state, date, requestVersion)) continue;
    if (requestVersion === (state.dateVersion[date] ?? 0)) {
      deleted.delete(date);
      dirty.delete(date);
      baseUpdatedAt[date] = null;
      ackedDateVersion[date] = requestVersion!;
    }
  }

  const next: SyncState = { ...state, dirtyDates: [...dirty], deletedDates: [...deleted], baseUpdatedAt, ackedDateVersion };
  if (!hasUnsynced(next)) {
    next.confirmed = true;
    next.lastFailureVersion = null;
  }
  return next;
};

export const applyConflict = (
  state: SyncState,
  conflicts: RemoteConflict["conflicts"],
  requestVersions: Record<string, number>
): SyncState => {
  const reviews = new Map(state.reviews.map((review) => [review.date, review]));
  const dirty = new Set(state.dirtyDates);
  const deleted = new Set(state.deletedDates);
  const baseUpdatedAt = { ...state.baseUpdatedAt };
  const ackedDateVersion = { ...state.ackedDateVersion };

  for (const conflict of conflicts) {
    const requestVersion = requestVersions[conflict.date];
    if (!acknowledgeDate(state, conflict.date, requestVersion)) continue;
    if (typeof conflict.review.updated_at === "string") baseUpdatedAt[conflict.date] = conflict.review.updated_at;
    if (requestVersion !== (state.dateVersion[conflict.date] ?? 0)) continue;

    if (deleted.has(conflict.date)) {
      deleted.delete(conflict.date);
      reviews.set(conflict.date, conflict.review);
      dirty.delete(conflict.date);
      ackedDateVersion[conflict.date] = requestVersion!;
      continue;
    }

    const local = reviews.get(conflict.date);
    const merged = local ? preserveBoth(local, conflict.review) : conflict.review;
    reviews.set(conflict.date, merged);
    if (contentSignature(merged) === contentSignature(conflict.review)) {
      dirty.delete(conflict.date);
      ackedDateVersion[conflict.date] = requestVersion!;
    } else {
      dirty.add(conflict.date);
    }
  }

  const next: SyncState = {
    ...state,
    reviews: sortReviews([...reviews.values()]),
    dirtyDates: [...dirty],
    deletedDates: [...deleted],
    baseUpdatedAt,
    ackedDateVersion
  };
  if (!hasUnsynced(next)) {
    next.confirmed = true;
    next.lastFailureVersion = null;
  }
  return next;
};

export const markSyncFailure = (state: SyncState, requestEditVersion: number): SyncState => {
  if (state.editVersion !== requestEditVersion) return state;
  return { ...state, lastFailureVersion: requestEditVersion };
};

export const requestFlush = (queue: FlushQueue): { queue: FlushQueue; start: boolean } => {
  if (queue.running) return { queue: { running: true, rerun: true }, start: false };
  return { queue: { running: true, rerun: false }, start: true };
};

export const finishFlush = (queue: FlushQueue): { queue: FlushQueue; startAgain: boolean } => {
  if (queue.rerun) return { queue: { running: true, rerun: false }, startAgain: true };
  return { queue: { running: false, rerun: false }, startAgain: false };
};

const isConflictOutcome = (outcome: RemoteOutcome): outcome is RemoteConflict =>
  outcome.ok === false && outcome.error === "conflict" && "conflicts" in outcome && Array.isArray(outcome.conflicts);

export class ReviewSyncController {
  state: SyncState;
  mutated = false;
  private queue: FlushQueue = { running: false, rerun: false };
  private inflight: Record<string, number> | null = null;
  private conflictRetries = 0;

  constructor(
    private readonly save: (request: SaveRequest) => Promise<RemoteOutcome>,
    private readonly persistLocal: () => boolean,
    initial: SyncState,
    private readonly onRemoteError?: (error: unknown) => void
  ) {
    this.state = initial;
  }

  status(): CloudSyncStatus {
    return displayStatus(this.state, this.inflight);
  }

  replaceState(state: SyncState) {
    this.state = state;
  }

  replaceReviews(reviews: ReviewRecord[]) {
    this.state = { ...this.state, reviews: sortReviews(reviews) };
  }

  edit(reviews: ReviewRecord[], date: string) {
    this.mutated = true;
    this.state = noteEdit(this.state, reviews, date);
    if (this.queue.running) this.queue = { ...this.queue, rerun: true };
  }

  deleteDate(date: string) {
    this.mutated = true;
    this.state = noteDelete(this.state, date);
    if (this.queue.running) this.queue = { ...this.queue, rerun: true };
  }

  mergeRemote(remote: ReviewRecord[]) {
    this.state = mergeRemoteSnapshot(this.state, remote);
  }

  markReadFailure() {
    if (!hasUnsynced(this.state)) return;
    this.state = markSyncFailure(this.state, this.state.editVersion);
  }

  async flush(): Promise<void> {
    const decision = requestFlush(this.queue);
    this.queue = decision.queue;
    if (!decision.start) return;
    try {
      do {
        await this.runOnce();
        const next = finishFlush(this.queue);
        this.queue = next.queue;
        if (!next.startAgain || !hasUnsynced(this.state)) {
          this.queue = { running: false, rerun: false };
          break;
        }
      } while (true);
    } finally {
      this.inflight = null;
      if (this.queue.running) this.queue = { running: false, rerun: false };
    }
  }

  private async runOnce() {
    const request = buildSaveRequest(this.state);
    if (request.reviews.length === 0 && request.deletedDates.length === 0) return;
    const requestEditVersion = this.state.editVersion;
    this.inflight = { ...request.dateVersions };
    let remote: RemoteOutcome | undefined;
    try {
      await persistWithLocalFallback({
        saveLocal: () => this.persistLocal(),
        saveRemote: async () => {
          try {
            remote = await this.save(request);
          } catch (error) {
            remote = { ok: false, error: "offline" };
            throw error;
          }
          if (!remote.ok) {
            const error = new Error(remote.error);
            Object.assign(error, { outcome: remote });
            throw error;
          }
          this.state = applyRemoteSuccess(this.state, remote, request.dateVersions);
        },
        reportRemoteError: (error) => {
          if (remote && isConflictOutcome(remote)) {
            this.state = applyConflict(this.state, remote.conflicts, request.dateVersions);
            if (hasUnsynced(this.state) && this.conflictRetries < 1) {
              this.conflictRetries += 1;
              this.queue = { ...this.queue, rerun: true };
              return;
            }
          }
          this.conflictRetries = 0;
          const failed = markSyncFailure(this.state, requestEditVersion);
          const shouldReport = failed !== this.state || (remote?.ok === false && remote.error !== "conflict");
          this.state = failed;
          if (shouldReport) this.onRemoteError?.(error);
        },
        acceptRemote: () => !hasUnsynced(this.state)
      });
      if (remote?.ok) this.conflictRetries = 0;
    } finally {
      this.inflight = null;
    }
  }
}
