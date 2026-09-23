import { describe, expect, it } from "vitest";
import type { ResultList } from "@scriptoria/contracts";
import { resultsRefetchInterval } from "../src/components/ResultPanel";

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
