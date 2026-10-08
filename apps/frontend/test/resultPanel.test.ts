import { describe, expect, it } from "vitest";
import type { ResultList, Run } from "@scriptoria/contracts";
import { archiveName, resultsRefetchInterval } from "../src/components/ResultPanel";

/**
 * When the results list is asked for again (FA-09.1).
 *
 * The mistake this pins down is an interval driven by the run: the interval
 * that stops when the run ends cancels the one fetch that would have seen the
 * collector's work, so a run ending inside the poll window shows an empty list
 * for ever. The list's own `partial` is what decides.
 */

function listing(partial: boolean): ResultList {
  return {
    runId: "a0d0f2e6-6f1c-4a63-9a5c-2a2d7a7f4f2e",
    directory: "/opt/scriptoria/export",
    files: [],
    totalBytes: 0,
    partial,
    collectedAt: "2026-09-23T04:05:06.000Z",
  };
}

describe("the results list's refresh", () => {
  it("keeps asking while the control plane says the list is not final", () => {
    expect(resultsRefetchInterval(listing(true))).toBe(5_000);
  });

  it("stops once the answer is final", () => {
    expect(resultsRefetchInterval(listing(false))).toBe(false);
  });

  it("keeps asking when no answer has arrived yet", () => {
    // Otherwise a first fetch that failed, or one still in flight when the run
    // ends, would leave the panel with nothing and no plan to ask again.
    expect(resultsRefetchInterval(undefined)).toBe(5_000);
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
function run(scriptFileName: string): Run {
  return {
    id: "a0d0f2e6-6f1c-4a63-9a5c-2a2d7a7f4f2e",
    areaId: "b1e1f3a7-7a2d-4b74-8b6d-3b3e8b8f5f3f",
    scriptId: "c2f2a4b8-8b3e-4c85-9c7e-4c4f9c9a6a4a",
    scriptFileName,
    scriptTitle: scriptFileName,
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
  };
}

describe("the archive's download name (FA-09.3)", () => {
  it("date-stamps the script's name from the run's queued time", () => {
    expect(archiveName(run("site-rollout.sh"))).toBe("site-rollout-2026-03-04-09-15-30.zip");
  });

  it("sanitises the name the way the control plane does, so the two agree", () => {
    // A name that is legal on the script VM and invalid in a response header.
    expect(archiveName(run("réport\nnightly.sh"))).toBe("r-port-nightly-2026-03-04-09-15-30.zip");
  });

  it("falls back when the script's name leaves nothing to build on", () => {
    expect(archiveName(run(".sh"))).toBe("results-2026-03-04-09-15-30.zip");
  });
});
