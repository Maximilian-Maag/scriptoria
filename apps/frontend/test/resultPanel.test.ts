import { describe, expect, it } from "vitest";
import type { ResultFile, ResultList, Run } from "@scriptoria/contracts";
import { archiveName, resultsRefetchInterval } from "../src/components/ResultPanel";

/**
 * When the results list is asked for again (FA-09.1, FA-09.5).
 *
 * Two mistakes are pinned down here, and they are the same mistake twice. The
 * first is an interval driven by the run: the interval that stops when the run
 * ends cancels the one fetch that would have seen the collector's work, so a
 * run ending inside the poll window shows an empty list for ever. The second is
 * the answer to the first — trusting the list's own `partial` and nothing else
 * — because the runner writes the run's terminal status *before* it lists the
 * output directory, so for a moment a finished run answers with an empty list
 * that is not `partial`. `partial`, the run's settled state and its
 * `resultCount` together are what end the polling.
 */

const RUN_ID = "a0d0f2e6-6f1c-4a63-9a5c-2a2d7a7f4f2e";

/** The interval that means "ask again in five seconds". */
const KEEP_ASKING = 5_000;

/** A result list in the state the control plane answers with. */
function listing(partial: boolean, files: number = 0): ResultList {
  const entries: ResultFile[] = Array.from({ length: files }, (_, i) => ({
    path: `sites/site-${i}.conf`,
    name: `site-${i}.conf`,
    sizeBytes: 128,
    modifiedAt: "2026-09-23T04:05:06.000Z",
    contentType: "text/plain",
    previewable: true,
  }));

  return {
    runId: RUN_ID,
    directory: "/opt/scriptoria/export",
    files: entries,
    totalBytes: entries.length * 128,
    partial,
    collectedAt: "2026-09-23T04:05:06.000Z",
  };
}

/** A run record; everything the interval reads is overridable per case. */
function run(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    areaId: "b1e1f3a7-7a2d-4b74-8b6d-3b3e8b8f5f3f",
    scriptId: "c2f2a4b8-8b3e-4c85-9c7e-4c4f9c9a6a4a",
    scriptFileName: "site-rollout.sh",
    scriptTitle: "site-rollout.sh",
    criticality: "read-only",
    status: "succeeded",
    trigger: "manual",
    startedBy: "admin.branch",
    host: "vm1.example.test",
    queuedAt: "2026-03-04T09:15:30.000Z",
    startedAt: "2026-03-04T09:15:31.000Z",
    finishedAt: "2026-03-04T09:16:00.000Z",
    exitCode: 0,
    failureReason: null,
    lastStreamId: null,
    resultCount: 1,
    collectedAt: null,
    ...overrides,
  };
}

describe("the results list's refresh (FA-09.1, FA-09.5)", () => {
  it("keeps asking while the control plane says the list is not final", () => {
    expect(resultsRefetchInterval(listing(true), run())).toBe(KEEP_ASKING);
  });

  it("keeps asking when no answer has arrived yet", () => {
    // Otherwise a first fetch that failed, or one still in flight when the run
    // ends, would leave the panel with nothing and no plan to ask again.
    expect(resultsRefetchInterval(undefined, run())).toBe(KEEP_ASKING);
  });

  it("keeps asking while the run has not ended, however final the list looks", () => {
    // The list and the run record are read independently, so a list that is not
    // `partial` is not on its own proof that the run is over.
    const live = run({ status: "running", finishedAt: null, resultCount: null });
    expect(resultsRefetchInterval(listing(false), live)).toBe(KEEP_ASKING);
  });

  it("keeps asking until the list holds what the run says it collected", () => {
    // The run record and this list land separately; the count can arrive here
    // first, and a stop on that answer would leave the empty list it is beside.
    expect(resultsRefetchInterval(listing(false, 0), run({ resultCount: 4 }))).toBe(KEEP_ASKING);
  });

  it("stops once the answer is final and the two agree on what there is", () => {
    expect(resultsRefetchInterval(listing(false, 1), run({ resultCount: 1 }))).toBe(false);
  });

  it("stops when the run ended with nothing to collect", () => {
    expect(resultsRefetchInterval(listing(false, 0), run({ resultCount: 0 }))).toBe(false);
  });

  it("stops once the collection ended, even if it recorded nothing", () => {
    // A collection that failed, and a run nobody will collect at all, end the
    // same way: a timestamp and no count. The interface reads that fact instead
    // of waiting out a timer.
    const ended = run({ resultCount: null, collectedAt: "2026-03-04T09:16:01.000Z" });
    expect(resultsRefetchInterval(listing(false, 0), ended)).toBe(false);
  });

  it("keeps asking while a collection has no end, however long it has been", () => {
    // Not a stopwatch. A null count with no collection end means the collector
    // is still working, and hundreds of files fetched one at a time over SFTP
    // take as long as they take — stopping here is the defect this exists to
    // prevent (#97).
    expect(resultsRefetchInterval(listing(false, 0), run({ resultCount: null }))).toBe(KEEP_ASKING);
  });
});

/**
 * FA-09.3 — the name the ZIP is saved under.
 *
 * It has to be the control plane's own name for the same archive: the platform
 * puts it in `Content-Disposition`, and the browser saves it from the blob URL
 * under this one. A second copy of the base-name rule here, without the
 * sanitiser, is how the two came to disagree for a non-Latin-1 script name.
 */
describe("the archive's download name (FA-09.3)", () => {
  it("date-stamps the script's name from the run's queued time", () => {
    expect(archiveName(run({ scriptFileName: "site-rollout.sh" }))).toBe(
      "site-rollout-2026-03-04-09-15-30.zip",
    );
  });

  it("sanitises the name the way the control plane does, so the two agree", () => {
    // A name that is legal on the script VM and invalid in a response header.
    expect(archiveName(run({ scriptFileName: "réport\nnightly.sh" }))).toBe(
      "r-port-nightly-2026-03-04-09-15-30.zip",
    );
  });

  it("falls back when the script's name leaves nothing to build on", () => {
    expect(archiveName(run({ scriptFileName: ".sh" }))).toBe("results-2026-03-04-09-15-30.zip");
  });
});
