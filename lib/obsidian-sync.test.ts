import assert from "node:assert/strict";
import test from "node:test";

import { authorizeObsidianDirectory } from "./obsidian-authorization.ts";
import {
  fingerprintMarkdown,
  mergeObsidianSyncCache,
  parseObsidianSyncCache,
  syncReviewsToDirectory
} from "./obsidian-sync.ts";
import { reviewToMarkdown } from "./review-markdown.ts";
import { ReviewRecord } from "./review.ts";

const handle = { name: "Daily Review" } as FileSystemDirectoryHandle;

const makeReview = (date: string, text: string): ReviewRecord => ({
  id: date,
  date,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  today_log: {
    red: [{ id: `red-${date}`, text, order_index: 0, reflection_qas: [] }],
    black: []
  }
});

const createDirectory = (options: { files?: Record<string, string>; failing?: string[] } = {}) => {
  const files = new Map(Object.entries(options.files ?? {}));
  const failing = new Set(options.failing ?? []);
  const writes: string[] = [];
  const accesses: string[] = [];

  const directory = {
    getFileHandle: async (name: string, config?: { create?: boolean }) => {
      accesses.push(name);
      if (!files.has(name) && !config?.create) {
        const error = new Error(`${name} not found`);
        error.name = "NotFoundError";
        throw error;
      }
      return {
        getFile: async () => ({ text: async () => files.get(name) ?? "" }),
        createWritable: async () => {
          let pending = "";
          return {
            write: async (contents: string) => { pending = contents; },
            close: async () => {
              if (failing.has(name)) {
                const error = new Error(`${name} cannot be written`);
                error.name = "NotAllowedError";
                throw error;
              }
              files.set(name, pending);
              writes.push(name);
            }
          };
        }
      };
    }
  };

  return {
    directory: directory as unknown as Parameters<typeof syncReviewsToDirectory>[0],
    files,
    writes,
    accesses
  };
};

test("syncs every missing or stale date and skips files that are already up to date", async () => {
  const dayOne = makeReview("2026-08-01", "第一天");
  const dayTwo = makeReview("2026-08-02", "第二天");
  const dayThree = makeReview("2026-08-03", "第三天");
  const { directory, files, writes } = createDirectory({
    files: {
      "2026-08-01.md": reviewToMarkdown(dayOne),
      "2026-08-03.md": "过期的旧内容"
    }
  });

  const result = await syncReviewsToDirectory(directory, [dayOne, dayTwo, dayThree]);

  assert.deepEqual(result.skipped, ["2026-08-01"]);
  assert.deepEqual(result.written, ["2026-08-02", "2026-08-03"]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual([...writes].sort(), ["2026-08-02.md", "2026-08-03.md"]);
  assert.equal(files.get("2026-08-02.md"), reviewToMarkdown(dayTwo));
  assert.equal(files.get("2026-08-03.md"), reviewToMarkdown(dayThree));
});

test("keeps syncing the remaining dates when one file cannot be written", async () => {
  const dayOne = makeReview("2026-08-01", "第一天");
  const dayTwo = makeReview("2026-08-02", "第二天");
  const dayThree = makeReview("2026-08-03", "第三天");
  const { directory, files } = createDirectory({ failing: ["2026-08-02.md"] });

  const result = await syncReviewsToDirectory(directory, [dayOne, dayTwo, dayThree]);

  assert.deepEqual(result.written, ["2026-08-01", "2026-08-03"]);
  assert.deepEqual(result.failed, ["2026-08-02"]);
  assert.equal(files.get("2026-08-01.md"), reviewToMarkdown(dayOne));
  assert.equal(files.get("2026-08-03.md"), reviewToMarkdown(dayThree));
});

test("dates already recorded in the sync cache skip the file system entirely", async () => {
  const dayOne = makeReview("2026-08-01", "第一天");
  const dayTwo = makeReview("2026-08-02", "第二天");
  const { directory, writes, accesses } = createDirectory();
  const dayOneFingerprint = fingerprintMarkdown(reviewToMarkdown(dayOne));

  const result = await syncReviewsToDirectory(directory, [dayOne, dayTwo], {
    syncedFingerprints: { "2026-08-01": dayOneFingerprint }
  });

  assert.deepEqual(result.skipped, ["2026-08-01"]);
  assert.deepEqual(result.written, ["2026-08-02"]);
  assert.deepEqual(accesses.filter((name) => name === "2026-08-01.md"), []);
  assert.ok(accesses.includes("2026-08-02.md"));
  assert.deepEqual(writes, ["2026-08-02.md"]);
  assert.deepEqual(result.fingerprints, {
    "2026-08-01": dayOneFingerprint,
    "2026-08-02": fingerprintMarkdown(reviewToMarkdown(dayTwo))
  });
});

test("a cache entry whose content changed is rewritten", async () => {
  const review = makeReview("2026-08-01", "新的内容");
  const { directory, files, writes } = createDirectory();

  const result = await syncReviewsToDirectory(directory, [review], {
    syncedFingerprints: { "2026-08-01": "stale-fingerprint" }
  });

  assert.deepEqual(result.written, ["2026-08-01"]);
  assert.deepEqual(writes, ["2026-08-01.md"]);
  assert.equal(files.get("2026-08-01.md"), reviewToMarkdown(review));
});

test("parses a sync cache and ignores malformed entries", () => {
  const raw = JSON.stringify({
    "Daily Review": { "2026-08-01": "abc" },
    broken: 42
  });

  assert.deepEqual(parseObsidianSyncCache(raw), { "Daily Review": { "2026-08-01": "abc" } });
  assert.deepEqual(parseObsidianSyncCache("not json"), {});
  assert.deepEqual(parseObsidianSyncCache(null), {});
});

test("merging the sync cache only keeps fingerprints for dates that synced successfully", () => {
  const dayOne = makeReview("2026-08-01", "第一天");
  const dayTwo = makeReview("2026-08-02", "第二天");
  const cache = { Other: { "2026-07-01": "other" } };

  const merged = mergeObsidianSyncCache(cache, "Daily Review", [dayOne, dayTwo], {
    written: ["2026-08-01"],
    skipped: [],
    failed: ["2026-08-02"],
    fingerprints: { "2026-08-01": "fp-1" }
  });

  assert.deepEqual(merged, {
    Other: { "2026-07-01": "other" },
    "Daily Review": { "2026-08-01": "fp-1" }
  });
});

test("does not request authorization again when the saved folder is still granted", async () => {
  let permissionRequests = 0;

  const authorized = await authorizeObsidianDirectory(handle, {
    pick: async () => ({ name: "Other" } as FileSystemDirectoryHandle),
    hasPermission: async (candidate) => candidate === handle,
    requestPermission: async () => {
      permissionRequests += 1;
      return true;
    },
    save: async () => undefined
  });

  assert.equal(authorized, handle);
  assert.equal(permissionRequests, 0);
});

test("reuses the saved Obsidian folder instead of opening the folder picker again", async () => {
  let pickerCalls = 0;
  let savedHandle: FileSystemDirectoryHandle | null = null;

  const authorized = await authorizeObsidianDirectory(handle, {
    pick: async () => {
      pickerCalls += 1;
      return { name: "Other" } as FileSystemDirectoryHandle;
    },
    hasPermission: async () => false,
    requestPermission: async (candidate) => candidate === handle,
    save: async (candidate) => { savedHandle = candidate; }
  });

  assert.equal(authorized, handle);
  assert.equal(pickerCalls, 0);
  assert.equal(savedHandle, handle);
});

test("opens the folder picker only when no saved folder exists", async () => {
  let pickerCalls = 0;
  const picked = { name: "Picked" } as FileSystemDirectoryHandle;

  const authorized = await authorizeObsidianDirectory(null, {
    pick: async () => {
      pickerCalls += 1;
      return picked;
    },
    hasPermission: async () => false,
    requestPermission: async () => true,
    save: async () => undefined
  });

  assert.equal(authorized, picked);
  assert.equal(pickerCalls, 1);
});
