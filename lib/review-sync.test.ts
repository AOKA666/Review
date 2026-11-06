import assert from "node:assert/strict";
import test from "node:test";

import { ReviewRecord } from "./review.ts";
import {
  applyConflict,
  applyRemoteSuccess,
  buildSaveRequest,
  displayStatus,
  emptySyncState,
  mergeRemoteSnapshot,
  noteDelete,
  noteEdit,
  parseSyncState,
  ReviewSyncController,
  serializeSyncState
} from "./review-sync.ts";
import { RemoteOutcome, SaveRequest } from "./save-response.ts";

const date = "2026-11-06";

const review = (text: string, updated_at = "2026-11-06T00:00:00.000Z", id = `red-${date}`): ReviewRecord => ({
  id: `journal-${date}`,
  date,
  created_at: updated_at,
  updated_at,
  today_log: {
    red: [{ id, text, order_index: 0, reflection_qas: [] }],
    black: []
  }
});

const otherDay = (day: string, text: string): ReviewRecord => ({
  ...review(text, `${day}T00:00:00.000Z`),
  id: `journal-${day}`,
  date: day,
  today_log: {
    red: [{ id: `red-${day}`, text, order_index: 0, reflection_qas: [] }],
    black: []
  }
});

const texts = (stateReview: ReviewRecord | undefined) =>
  stateReview?.today_log.red.map((item) => item.text) ?? [];

const success = (updatedAt: string, savedDate = date): RemoteOutcome => ({
  ok: true,
  savedDates: [savedDate],
  deletedDates: [],
  updatedAtByDate: { [savedDate]: updatedAt }
});

test("reading legacy localStorage does not mark local additions as cloud synced", () => {
  const state = parseSyncState(JSON.stringify([review("only on this computer")]));

  assert.equal(displayStatus(state, null), "pending");
  assert.equal(state.confirmed, false);
  assert.deepEqual(state.dirtyDates, [date]);
});

test("a previously confirmed cache can show synced, and a newer local edit cannot", () => {
  const confirmed = parseSyncState(serializeSyncState({
    ...emptySyncState(),
    reviews: [review("already uploaded")],
    editVersion: 2,
    dateVersion: { [date]: 2 },
    ackedDateVersion: { [date]: 2 },
    baseUpdatedAt: { [date]: "t2" },
    confirmed: true
  }));
  const edited = noteEdit(confirmed, [review("typed after refresh")], date);

  assert.equal(displayStatus(confirmed, null), "synced");
  assert.equal(displayStatus(edited, null), "pending");
  assert.equal(serializeSyncState(edited).includes("\"confirmed\":true"), true);
  assert.equal(parseSyncState(serializeSyncState(edited)).dirtyDates.includes(date), true);
});

test("a remote read keeps dirty local text and does not mark that addition synced", () => {
  const local = parseSyncState(JSON.stringify([review("company only")]));
  const remote = review("already at home", "2026-11-06T03:00:00.000Z");
  const merged = mergeRemoteSnapshot(local, [remote]);

  assert.equal(displayStatus(merged, null), "pending");
  assert.ok(texts(merged.reviews[0]).includes("company only"));
  assert.ok(texts(merged.reviews[0]).includes("already at home"));
  assert.equal(merged.baseUpdatedAt[date], remote.updated_at);
});

test("a remote read can confirm a date only when the cloud copy already matches", () => {
  const local = parseSyncState(JSON.stringify([review("same words")]));
  const merged = mergeRemoteSnapshot(local, [review("same words", "2026-11-06T03:00:00.000Z")]);

  assert.deepEqual(merged.dirtyDates, []);
  assert.equal(displayStatus(merged, null), "synced");
});

test("an older ack cannot mark a newer edit synced, and a late ack cannot roll the version back", () => {
  let state = noteEdit(emptySyncState(), [review("second")], date);
  state = noteEdit(state, [review("second")], date);
  state = applyRemoteSuccess(state, {
    savedDates: [date],
    deletedDates: [],
    updatedAtByDate: { [date]: "t1" }
  }, { [date]: 1 });

  assert.equal(displayStatus(state, null), "pending");
  assert.equal(texts(state.reviews[0])[0], "second");

  state = applyRemoteSuccess(state, {
    savedDates: [date],
    deletedDates: [],
    updatedAtByDate: { [date]: "t2" }
  }, { [date]: 2 });
  state = applyRemoteSuccess(state, {
    savedDates: [date],
    deletedDates: [],
    updatedAtByDate: { [date]: "t1" }
  }, { [date]: 1 });

  assert.equal(displayStatus(state, null), "synced");
  assert.equal(state.baseUpdatedAt[date], "t2");
});

test("save requests contain dirty dates and explicit deletes, never a full snapshot", () => {
  let state = noteEdit(emptySyncState(), [otherDay(date, "today"), otherDay("2026-11-05", "yesterday")], date);
  state = {
    ...state,
    baseUpdatedAt: { ...state.baseUpdatedAt, "2026-11-05": "server-yesterday" }
  };
  state = noteDelete(state, "2026-11-05");
  const request = buildSaveRequest(state);

  assert.deepEqual(request.reviews.map((item) => item.date), [date]);
  assert.deepEqual(request.deletedDates, ["2026-11-05"]);
  assert.equal(request.baseUpdatedAt["2026-11-05"], "server-yesterday");
});

test("a rejected or offline save keeps the local text and a retry sends it again", async () => {
  let attempt = 0;
  const controller = new ReviewSyncController(async () => {
    attempt += 1;
    if (attempt === 1) return { ok: false, error: "items_delete" };
    if (attempt === 2) throw new Error("offline");
    return success("t3");
  }, () => true, emptySyncState());

  controller.edit([review("keep me")], date);
  await controller.flush();
  assert.equal(controller.status(), "error");
  assert.equal(texts(controller.state.reviews[0])[0], "keep me");

  await controller.flush();
  assert.equal(controller.status(), "error");
  assert.equal(texts(controller.state.reviews[0])[0], "keep me");

  await controller.flush();
  assert.equal(controller.status(), "synced");
  assert.equal(texts(controller.state.reviews[0])[0], "keep me");
});

test("overlapping edits stay serial and an older response cannot finish as synced", async () => {
  let releaseFirst: (value: RemoteOutcome) => void = () => undefined;
  const first = new Promise<RemoteOutcome>((resolve) => {
    releaseFirst = resolve;
  });
  const seen: string[] = [];
  let controller!: ReviewSyncController;
  const save = async (request: SaveRequest): Promise<RemoteOutcome> => {
    const text = request.reviews[0]?.today_log.red[0]?.text ?? "";
    seen.push(text);
    if (seen.length === 1) return first;
    assert.equal(controller.state.dirtyDates.includes(date), true);
    return success("t2");
  };
  controller = new ReviewSyncController(save, () => true, emptySyncState());

  controller.edit([review("one")], date);
  const flushing = controller.flush();
  controller.edit([review("two")], date);
  assert.equal(controller.status(), "pending");
  releaseFirst(success("t1"));
  await flushing;

  assert.deepEqual(seen, ["one", "two"]);
  assert.equal(texts(controller.state.reviews[0])[0], "two");
  assert.equal(controller.status(), "synced");
  assert.equal(controller.state.baseUpdatedAt[date], "t2");
});

test("a conflict keeps both copies and the automatic retry uploads the merge", async () => {
  const remote = review("from home", "2026-11-06T04:00:00.000Z");
  let attempt = 0;
  const controller = new ReviewSyncController(async (request) => {
    attempt += 1;
    if (attempt === 1) {
      return { ok: false, error: "conflict", conflicts: [{ date, review: remote }] };
    }
    assert.equal(request.baseUpdatedAt[date], remote.updated_at);
    assert.ok(texts(request.reviews[0]).includes("company"));
    assert.ok(texts(request.reviews[0]).includes("from home"));
    return success("t5");
  }, () => true, emptySyncState());

  controller.edit([review("company")], date);
  await controller.flush();

  assert.equal(attempt, 2);
  assert.equal(controller.status(), "synced");
  assert.ok(texts(controller.state.reviews[0]).includes("company"));
  assert.ok(texts(controller.state.reviews[0]).includes("from home"));
});

test("a delete conflict restores the remote day instead of deleting unseen content", () => {
  let state = noteEdit(emptySyncState(), [review("old")], date);
  state = applyRemoteSuccess(state, {
    savedDates: [date],
    deletedDates: [],
    updatedAtByDate: { [date]: "t0" }
  }, { [date]: state.dateVersion[date] ?? 0 });
  state = noteDelete(state, date);
  const remote = review("newer from home", "t1");
  state = applyConflict(state, [{ date, review: remote }], { [date]: state.dateVersion[date] ?? 0 });

  assert.deepEqual(state.deletedDates, []);
  assert.equal(texts(state.reviews[0])[0], "newer from home");
});

test("startup merge cancels a pending delete when the cloud copy changed", () => {
  const state = {
    ...emptySyncState(),
    deletedDates: [date],
    baseUpdatedAt: { [date]: "t0" },
    dateVersion: { [date]: 2 },
    editVersion: 2
  };
  const merged = mergeRemoteSnapshot(state, [review("still on the other computer", "t1")]);

  assert.deepEqual(merged.deletedDates, []);
  assert.equal(texts(merged.reviews[0])[0], "still on the other computer");
});

test("a failed cloud read leaves dirty local content unsynced", () => {
  const controller = new ReviewSyncController(async () => success("t1"), () => true, emptySyncState());
  controller.edit([review("offline draft")], date);
  controller.markReadFailure();

  assert.equal(controller.status(), "error");
  assert.equal(texts(controller.state.reviews[0])[0], "offline draft");
  assert.equal(controller.state.confirmed, false);
});
