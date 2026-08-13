import assert from "node:assert/strict";
import test from "node:test";

import { authorizeObsidianDirectory } from "./obsidian-authorization.ts";

const handle = { name: "Daily Review" } as FileSystemDirectoryHandle;

test("reuses the saved Obsidian folder instead of opening the folder picker again", async () => {
  let pickerCalls = 0;
  let savedHandle: FileSystemDirectoryHandle | null = null;

  const authorized = await authorizeObsidianDirectory(handle, {
    pick: async () => {
      pickerCalls += 1;
      return { name: "Other" } as FileSystemDirectoryHandle;
    },
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
    requestPermission: async () => true,
    save: async () => undefined
  });

  assert.equal(authorized, picked);
  assert.equal(pickerCalls, 1);
});
