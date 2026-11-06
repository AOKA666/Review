import assert from "node:assert/strict";
import test from "node:test";

import { persistWithLocalFallback } from "./save-status.ts";

test("reports an error when cloud sync fails even after local persistence succeeds", async () => {
  let reportedError: unknown;

  const status = await persistWithLocalFallback({
    saveLocal: () => true,
    saveRemote: async () => { throw new Error("temporary cloud failure"); },
    reportRemoteError: (error) => { reportedError = error; }
  });

  assert.equal(status, "error");
  assert.match(String(reportedError), /temporary cloud failure/);
});

test("reports an error when local persistence fails even if cloud sync also fails", async () => {
  const status = await persistWithLocalFallback({
    saveLocal: () => false,
    saveRemote: async () => { throw new Error("cloud failure"); },
    reportRemoteError: () => undefined
  });

  assert.equal(status, "error");
});

test("confirms a cloud sync only when the latest server ack is accepted", async () => {
  const synced = await persistWithLocalFallback({
    saveLocal: () => true,
    saveRemote: async () => undefined,
    reportRemoteError: () => undefined
  });
  const stale = await persistWithLocalFallback({
    saveLocal: () => true,
    saveRemote: async () => undefined,
    reportRemoteError: () => undefined,
    acceptRemote: () => false
  });

  assert.equal(synced, "synced");
  assert.equal(stale, "pending");
  assert.notEqual(stale, "synced");
});
