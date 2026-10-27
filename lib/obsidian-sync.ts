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

const isNotFoundError = (error: unknown) =>
  typeof error === "object" && error !== null && "name" in error
  && (error as { name?: string }).name === "NotFoundError";

const readExistingMarkdown = async (handle: DirectoryHandle, date: string) => {
  try {
    const file = await handle.getFileHandle(`${date}.md`);
    return await (await file.getFile()).text();
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
};

const writeMarkdown = async (handle: DirectoryHandle, date: string, markdown: string) => {
  const file = await handle.getFileHandle(`${date}.md`, { create: true });
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
};

export type ObsidianDirectorySyncOptions = {
  // Date -> fingerprint of the Markdown that was last written to this folder.
  // Matching entries skip the file system entirely.
  syncedFingerprints?: Readonly<Record<string, string>>;
};

// File system calls are the slow part of syncing. Running several at once
// keeps a large vault from taking seconds per click.
const SYNC_CONCURRENCY = 8;

export const syncReviewsToDirectory = async (
  handle: DirectoryHandle,
  reviews: ReviewRecord[],
  options: ObsidianDirectorySyncOptions = {}
): Promise<ObsidianDirectorySyncResult> => {
  const syncedFingerprints = options.syncedFingerprints ?? {};
  const outcomes = new Array<"written" | "skipped" | "failed">(reviews.length);
  const fingerprints: Record<string, string> = {};
  let cursor = 0;

  const syncOne = async (index: number) => {
    const review = reviews[index];
    const markdown = reviewToMarkdown(review);
    const fingerprint = fingerprintMarkdown(markdown);
    try {
      if (syncedFingerprints[review.date] === fingerprint) {
        outcomes[index] = "skipped";
        fingerprints[review.date] = fingerprint;
        return;
      }
      // Unknown or stale: compare on disk once so unchanged files are not
      // rewritten and Obsidian watchers are not woken up needlessly.
      if ((await readExistingMarkdown(handle, review.date)) === markdown) {
        outcomes[index] = "skipped";
      } else {
        await writeMarkdown(handle, review.date, markdown);
        outcomes[index] = "written";
      }
      fingerprints[review.date] = fingerprint;
    } catch {
      outcomes[index] = "failed";
    }
  };

  const worker = async () => {
    while (cursor < reviews.length) {
      const index = cursor;
      cursor += 1;
      await syncOne(index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SYNC_CONCURRENCY, reviews.length) }, () => worker())
  );

  const datesWith = (outcome: "written" | "skipped" | "failed") =>
    reviews.filter((_, index) => outcomes[index] === outcome).map((review) => review.date);

  return {
    written: datesWith("written"),
    skipped: datesWith("skipped"),
    failed: datesWith("failed"),
    fingerprints
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
