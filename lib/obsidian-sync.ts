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

export type ObsidianDirectorySyncResult = {
  written: string[];
  skipped: string[];
  failed: string[];
};

export const syncReviewsToDirectory = async (
  handle: DirectoryHandle,
  reviews: ReviewRecord[]
): Promise<ObsidianDirectorySyncResult> => {
  const result: ObsidianDirectorySyncResult = { written: [], skipped: [], failed: [] };

  for (const review of reviews) {
    const markdown = reviewToMarkdown(review);
    try {
      // Unchanged files are left untouched so Obsidian and local file watchers
      // are only woken up for dates that actually still need syncing.
      if ((await readExistingMarkdown(handle, review.date)) === markdown) {
        result.skipped.push(review.date);
        continue;
      }
      const file = await handle.getFileHandle(`${review.date}.md`, { create: true });
      const writable = await file.createWritable();
      await writable.write(markdown);
      await writable.close();
      result.written.push(review.date);
    } catch {
      result.failed.push(review.date);
    }
  }

  return result;
};

export type ObsidianDirectoryHandle = DirectoryHandle;
