import assert from "node:assert/strict";
import test from "node:test";

import { fetchRemoteReviews, interpretSaveHttp, postReviewSave } from "./save-response.ts";
import { SaveRequest } from "./save-response.ts";

const request: SaveRequest = {
  reviews: [],
  deletedDates: [],
  baseUpdatedAt: {},
  dateVersions: { "2026-11-06": 3 }
};

test("a 200 response with ok false is a failure, not a cloud ack", () => {
  const outcome = interpretSaveHttp(200, JSON.stringify({ ok: false, error: "journals_delete" }));

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error, "journals_delete");
});

test("non-2xx responses and unreadable bodies fail closed", () => {
  assert.equal(interpretSaveHttp(500, JSON.stringify({ ok: true })).ok, false);
  assert.equal(interpretSaveHttp(200, "not-json").ok, false);
  assert.equal(interpretSaveHttp(409, JSON.stringify({ ok: false, error: "conflict", conflicts: [] })).ok, false);
});

test("a conflict body preserves the server review for the client merge", () => {
  const review = {
    id: "server",
    date: "2026-11-06",
    created_at: "t0",
    updated_at: "t1",
    today_log: { red: [{ id: "red", text: "from home", order_index: 0, reflection_qas: [] }], black: [] }
  };
  const outcome = interpretSaveHttp(409, JSON.stringify({
    ok: false,
    error: "conflict",
    conflicts: [{ date: "2026-11-06", review }]
  }));

  assert.equal(outcome.ok, false);
  if (!outcome.ok && outcome.error === "conflict" && "conflicts" in outcome) {
    assert.equal(outcome.conflicts[0]?.review.today_log.red[0]?.text, "from home");
  } else {
    assert.fail("expected a conflict");
  }
});

test("ok true is accepted only with the saved version map", () => {
  const outcome = interpretSaveHttp(200, JSON.stringify({
    ok: true,
    savedDates: ["2026-11-06"],
    deletedDates: [],
    updatedAtByDate: { "2026-11-06": "t2" }
  }));

  assert.deepEqual(outcome, {
    ok: true,
    savedDates: ["2026-11-06"],
    deletedDates: [],
    updatedAtByDate: { "2026-11-06": "t2" }
  });
});

test("the wire payload omits client versions and treats HTTP ok false as rejection", async () => {
  let body = "";
  const outcome = await postReviewSave(request, async (_input, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ ok: false, error: "items_delete" }), { status: 200 });
  });

  assert.equal(outcome.ok, false);
  assert.equal(JSON.parse(body).dateVersions, undefined);
  await assert.rejects(() => fetchRemoteReviews(async () => new Response("nope", { status: 500 })));
});
