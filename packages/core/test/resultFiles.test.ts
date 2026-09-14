import { describe, expect, it } from "vitest";
import { archiveFileName, contentTypeFor, isPreviewable } from "../src/resultFiles";

describe("contentTypeFor", () => {
  it("recognises what the scripts actually write", () => {
    expect(contentTypeFor("inventory.csv")).toBe("text/csv");
    expect(contentTypeFor("rollout.log")).toBe("text/plain");
    expect(contentTypeFor("report.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("falls back to octet-stream for anything it does not know", () => {
    expect(contentTypeFor("dump")).toBe("application/octet-stream");
    expect(contentTypeFor(".hidden")).toBe("application/octet-stream");
  });
});

describe("isPreviewable", () => {
  it("previews text, and only text", () => {
    expect(isPreviewable("inventory.csv", 2048)).toBe(true);
    expect(isPreviewable("report.xlsx", 2048)).toBe(false);
  });

  it("refuses to inline a file large enough to lock a browser tab", () => {
    expect(isPreviewable("huge.log", 50_000_000)).toBe(false);
  });
});

describe("archiveFileName", () => {
  it("date-stamps like the export directories the scripts write", () => {
    expect(archiveFileName("site-rollout.sh", new Date("2026-03-04T09:15:30Z"))).toBe(
      "site-rollout-2026-03-04-09-15-30.zip",
    );
  });
});
