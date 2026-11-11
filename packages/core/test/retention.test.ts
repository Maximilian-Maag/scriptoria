import { describe, expect, it } from "vitest";
import { retentionCutoff } from "../src/retention";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-11T12:00:00.000Z");

describe("retentionCutoff", () => {
  it("turns a window in days into the instant before which a transcript may go", () => {
    expect(retentionCutoff(90, NOW).cutoff?.toISOString()).toBe("2026-08-13T12:00:00.000Z");
  });

  it("keeps everything at zero, which is what an undecided deployment gets", () => {
    // The failure this pins: a default that prunes when nobody asked for it. A
    // deployment that has not configured retention must not delete its only copy.
    expect(retentionCutoff(0, NOW).cutoff).toBeNull();
  });

  it("keeps everything for a nonsense value rather than treating it as zero days", () => {
    expect(retentionCutoff(-1, NOW).cutoff).toBeNull();
    expect(retentionCutoff(Number.NaN, NOW).cutoff).toBeNull();
  });

  it("moves by exactly the number of days, at midnight crossers included", () => {
    const cutoff = retentionCutoff(1, NOW).cutoff!;
    expect(NOW.getTime() - cutoff.getTime()).toBe(DAY);
  });
});
