import { describe, expect, it } from "vitest";
import type { Run } from "@scriptoria/contracts";
import { COLLECTION_GRACE_MS, collectionSettled } from "../src/collection";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");

const run = (over: Partial<Run>): Run =>
  ({
    id: "00000000-0000-0000-0000-000000000000",
    status: "succeeded",
    finishedAt: new Date(NOW - 1_000).toISOString(),
    resultCount: null,
    ...over,
  }) as Run;

describe("collectionSettled", () => {
  it("is not settled while the run is still going", () => {
    expect(collectionSettled(run({ status: "running", finishedAt: null }), NOW)).toBe(false);
    expect(collectionSettled(run({ status: "queued", finishedAt: null }), NOW)).toBe(false);
  });

  /**
   * The case the interface got wrong: finished, but the collector has not
   * reported yet. Stopping here is what showed "No result files" for a run that
   * had four.
   */
  it("is not settled in the gap between the process exiting and the collection", () => {
    expect(collectionSettled(run({ status: "succeeded", resultCount: null }), NOW)).toBe(false);
  });

  it("is settled once a count exists, including a count of none", () => {
    expect(collectionSettled(run({ resultCount: 4 }), NOW)).toBe(true);
    expect(collectionSettled(run({ resultCount: 0 }), NOW)).toBe(true);
  });

  it("is settled for a failed run that never reached the script VM", () => {
    expect(collectionSettled(run({ status: "failed", finishedAt: null }), NOW)).toBe(true);
  });

  it("gives up on a collection that never reports", () => {
    const finishedAt = new Date(NOW - COLLECTION_GRACE_MS - 1).toISOString();
    expect(collectionSettled(run({ finishedAt }), NOW)).toBe(true);
  });

  it("an aborted run is collected like any other — it wrote what it wrote", () => {
    expect(collectionSettled(run({ status: "aborted", resultCount: null }), NOW)).toBe(false);
    expect(collectionSettled(run({ status: "aborted", resultCount: 2 }), NOW)).toBe(true);
  });
});
