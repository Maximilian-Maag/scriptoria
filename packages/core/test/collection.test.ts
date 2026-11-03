import { describe, expect, it } from "vitest";
import type { Run } from "@scriptoria/contracts";
import { collectionSettled } from "../src/collection";

const run = (over: Partial<Run>): Run =>
  ({
    id: "00000000-0000-0000-0000-000000000000",
    status: "succeeded",
    finishedAt: "2026-09-17T11:59:59.000Z",
    resultCount: null,
    collectedAt: null,
    ...over,
  }) as Run;

describe("collectionSettled", () => {
  it("is not settled while the run is still going", () => {
    expect(collectionSettled(run({ status: "running", finishedAt: null }))).toBe(false);
    expect(collectionSettled(run({ status: "queued", finishedAt: null }))).toBe(false);
  });

  /**
   * The case the interface got wrong: finished, but the collector has not
   * reported yet. Stopping here is what showed "No result files" for a run that
   * had four.
   */
  it("is not settled in the gap between the process exiting and the collection", () => {
    expect(collectionSettled(run({ status: "succeeded", resultCount: null }))).toBe(false);
  });

  it("is settled once a count exists, including a count of none", () => {
    expect(collectionSettled(run({ resultCount: 4 }))).toBe(true);
    expect(collectionSettled(run({ resultCount: 0 }))).toBe(true);
  });

  it("is settled for a failed run that never reached the script VM", () => {
    expect(collectionSettled(run({ status: "failed", finishedAt: null }))).toBe(true);
  });

  /**
   * The reason this is no longer a stopwatch. A collection that has not reported
   * is not a collection that failed, however long it has been going: hundreds of
   * files fetched one at a time over SFTP is the ordinary case, and the run below
   * is exactly that — finished an hour ago and still working.
   */
  it("waits for a collection however long it takes", () => {
    const finishedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(collectionSettled(run({ finishedAt }))).toBe(false);
  });

  /**
   * The other ending, and the one with no number: the listing failed, or the run
   * was cancelled before a worker claimed it, or its worker was reaped. All three
   * record a collection end and nothing to show.
   */
  it("is settled when the collection ended with nothing to record", () => {
    expect(collectionSettled(run({ collectedAt: "2026-09-17T12:00:00.000Z" }))).toBe(true);
  });

  it("an aborted run is collected like any other — it wrote what it wrote", () => {
    expect(collectionSettled(run({ status: "aborted", resultCount: null }))).toBe(false);
    expect(collectionSettled(run({ status: "aborted", resultCount: 2 }))).toBe(true);
  });
});
