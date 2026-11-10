import { ReviewRecord } from "./review";
import { reviewToMarkdown } from "./review-markdown";

export type ObsidianSyncStatus = "unsupported" | "disconnected" | "connected" | "permission" | "syncing" | "synced" | "error";

type DirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(options?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
};

const DB_NAME = "repano_obsidian";
const STORE_NAME = "handles";
const HANDLE_KEY = "daily-review-folder";

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export const supportsObsidianSync = () =>
  typeof window !== "undefined" && "showDirectoryPicker" in window && "indexedDB" in window;

export const pickDirectory = () =>
  (window as unknown as Window & { showDirectoryPicker(options?: { mode?: "read" | "readwrite" }): Promise<DirectoryHandle> })
    .showDirectoryPicker({ mode: "readwrite" });

export const saveDirectoryHandle = async (handle: DirectoryHandle) => {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
};

export const loadDirectoryHandle = async () => {
  const db = await openDatabase();
  const handle = await new Promise<DirectoryHandle | undefined>((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(HANDLE_KEY);
    request.onsuccess = () => resolve(request.result as DirectoryHandle | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return handle;
};

export const hasWritePermission = async (handle: DirectoryHandle) =>
  (await handle.queryPermission({ mode: "readwrite" })) === "granted";

export const requestWritePermission = async (handle: DirectoryHandle) =>
  (await handle.requestPermission({ mode: "readwrite" })) === "granted";

const errorName = (error: unknown) =>
  typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: string }).name ?? "")
    : "";

const isNotFoundError = (error: unknown) => errorName(error) === "NotFoundError";

const isPermissionError = (error: unknown) => {
  const name = errorName(error);
  return name === "NotAllowedError" || name === "SecurityError" || name === "NotReadableError";
};

// Windows rejects ":" in file names. A timestamptz that leaked into `date`
// would make every createWritable fail, so the vault file stays on the calendar day.
export const obsidianFileName = (date: string) => {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(date);
  return `${match?.[1] ?? date}.md`;
};

const sameMarkdown = (left: string | null, right: string) =>
  left != null && left.replace(/\r\n/g, "\n") === right.replace(/\r\n/g, "\n");

const readExistingMarkdown = async (handle: DirectoryHandle, date: string) => {
  try {
    const file = await handle.getFileHandle(obsidianFileName(date));
    return await (await file.getFile()).text();
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
};

const writeMarkdown = async (handle: DirectoryHandle, date: string, markdown: string) => {
  const file = await handle.getFileHandle(obsidianFileName(date), { create: true });
  const writable = await file.createWritable();
  await writable.write(markdown);
  await writable.close();
};

// FNV-1a hash of the rendered Markdown. The length is mixed in to make
// accidental collisions between similarly sized entries even less likely.
export const fingerprintMarkdown = (markdown: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < markdown.length; index += 1) {
    hash ^= markdown.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${markdown.length.toString(36)}-${(hash >>> 0).toString(36)}`;
};

export type ObsidianDirectorySyncResult = {
  written: string[];
  skipped: string[];
  failed: string[];
  fingerprints: Record<string, string>;
  permissionDenied: boolean;
};

export type ObsidianDirectorySyncOptions = {
  // Retained for callers that still record the last written hash. A matching
  // hash is not enough to skip: the vault file can exist while its bytes are older.
  syncedFingerprints?: Readonly<Record<string, string>>;
};

export const syncReviewsToDirectory = async (
  handle: DirectoryHandle,
  reviews: ReviewRecord[],
  options: ObsidianDirectorySyncOptions = {}
): Promise<ObsidianDirectorySyncResult> => {
  // The hash is recorded after a confirmed write. It must not decide the skip.
  void options.syncedFingerprints;
  const outcomes = new Array<"written" | "skipped" | "failed">(reviews.length);
  const fingerprints: Record<string, string> = {};
  let permissionDenied = false;

  for (let index = 0; index < reviews.length; index += 1) {
    const review = reviews[index];
    let markdown = "";
    try {
      markdown = reviewToMarkdown(review);
      const fingerprint = fingerprintMarkdown(markdown);
      const existing = await readExistingMarkdown(handle, review.date);
      if (sameMarkdown(existing, markdown)) {
        outcomes[index] = "skipped";
        fingerprints[review.date] = fingerprint;
        continue;
      }
      await writeMarkdown(handle, review.date, markdown);
      const confirmed = await readExistingMarkdown(handle, review.date);
      if (!sameMarkdown(confirmed, markdown)) {
        outcomes[index] = "failed";
        continue;
      }
      outcomes[index] = "written";
      fingerprints[review.date] = fingerprint;
    } catch (error) {
      outcomes[index] = "failed";
      if (isPermissionError(error)) permissionDenied = true;
    }
  }

  const datesWith = (outcome: "written" | "skipped" | "failed") =>
    reviews.filter((_, index) => outcomes[index] === outcome).map((review) => review.date);

  return {
    written: datesWith("written"),
    skipped: datesWith("skipped"),
    failed: datesWith("failed"),
    fingerprints,
    permissionDenied: permissionDenied && outcomes.every((outcome) => outcome !== "written" && outcome !== "skipped")
  };
};

export type ObsidianSyncCache = Record<string, Record<string, string>>;

const isFingerprintRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" && value !== null
  && Object.values(value).every((entry) => typeof entry === "string");

export const parseObsidianSyncCache = (raw: string | null): ObsidianSyncCache => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => isFingerprintRecord(value))
    );
  } catch {
    return {};
  }
};

export const mergeObsidianSyncCache = (
  cache: ObsidianSyncCache,
  folderName: string,
  reviews: ReviewRecord[],
  result: ObsidianDirectorySyncResult
): ObsidianSyncCache => {
  const folder: Record<string, string> = {};
  for (const review of reviews) {
    const fingerprint = result.fingerprints[review.date];
    if (fingerprint) folder[review.date] = fingerprint;
  }
  return { ...cache, [folderName]: folder };
};

export type ObsidianDirectoryHandle = DirectoryHandle;
