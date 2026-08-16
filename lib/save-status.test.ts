import assert from "node:assert/strict";
import test from "node:test";

import { persistWithLocalFallback } from "./save-status.ts";

test("keeps the saved status when cloud sync fails after local persistence succeeds", async () => {
  let reportedError: unknown;

  const status = await persistWithLocalFallback({
    saveLocal: () => true,
    saveRemote: async () => { throw new Error("temporary cloud failure"); },
    reportRemoteError: (error) => { reportedError = error; }
  });

  assert.equal(status, "saved");
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
