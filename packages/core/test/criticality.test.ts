import { describe, expect, it } from "vitest";
import {
  authoriseAbort,
  effectiveCriticality,
  isModifying,
  requiresAbortConfirmation,
} from "../src/criticality";

describe("effectiveCriticality", () => {
  it("lets the admin override beat the header", () => {
    expect(effectiveCriticality("modifying", { criticality: "read-only", extra: {} })).toBe(
      "modifying",
    );
  });

  it("falls back to the header when there is no override", () => {
    expect(effectiveCriticality(null, { criticality: "read-only", extra: {} })).toBe("read-only");
  });

  it("is unknown when nothing declares anything", () => {
    expect(effectiveCriticality(null, null)).toBe("unknown");
  });
});

describe("the safe default", () => {
  it("treats an undeclared script as modifying", () => {
    // ADR-004: the cost of wrongly warning about a read-only script is a click.
    // The cost of the reverse is an unannounced change to every system it touches.
    expect(isModifying("unknown")).toBe(true);
    expect(requiresAbortConfirmation("unknown")).toBe(true);
  });
});

describe("authoriseAbort", () => {
  it("aborts a read-only run with no confirmation at all", () => {
    expect(authoriseAbort("read-only", "inventory-report.sh", undefined)).toEqual({ ok: true });
  });

  it("refuses a modifying run without a confirmation", () => {
    expect(authoriseAbort("modifying", "site-rollout.sh", undefined)).toEqual({
      ok: false,
      reason: "confirmation_required",
    });
  });

  it("refuses when the confirmation names a different script", () => {
    // The failure this prevents is stopping the wrong run out of a list, which
    // a yes/no dialogue does not prevent.
    expect(authoriseAbort("modifying", "site-rollout.sh", "inventory-report.sh")).toEqual({
      ok: false,
      reason: "confirmation_mismatch",
    });
  });

  it("accepts the matching name, whitespace forgiven", () => {
    expect(authoriseAbort("modifying", "site-rollout.sh", "  site-rollout.sh ")).toEqual({
      ok: true,
    });
  });

  it("holds an unknown-criticality run to the modifying rule", () => {
    expect(authoriseAbort("unknown", "mystery.sh", undefined).ok).toBe(false);
    expect(authoriseAbort("unknown", "mystery.sh", "mystery.sh").ok).toBe(true);
  });
});
