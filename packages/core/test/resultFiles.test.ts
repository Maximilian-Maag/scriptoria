import { describe, expect, it } from "vitest";
import {
  archiveFileName,
  contentTypeFor,
  isPreviewable,
  sanitiseArchiveEntry,
  sanitiseFileName,
} from "../src/resultFiles";

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

  it("sanitises the script name instead of passing it through", () => {
    expect(archiveFileName("réport\nnightly.sh", new Date("2026-03-04T09:15:30Z"))).toBe(
      "r-port-nightly-2026-03-04-09-15-30.zip",
    );
  });

  it("still names an archive when the script name leaves no base behind", () => {
    expect(archiveFileName(".sh", new Date("2026-03-04T09:15:30Z"))).toBe(
      "results-2026-03-04-09-15-30.zip",
    );
  });
});

/**
 * FA-09.2 / FA-09.3. The one sanitiser behind every name that reaches a
 * response header or a ZIP entry. A newline is legal in a file name on the
 * script VM, and `Headers` throws on one rather than rendering it; a name
 * outside Latin-1 does the same. So a name is reduced to the character set both
 * a header and an archive entry are unambiguously safe in.
 */
describe("sanitiseFileName", () => {
  it("leaves a name that was already safe alone", () => {
    expect(sanitiseFileName("site-rollout.csv")).toBe("site-rollout.csv");
  });

  it("replaces a control character rather than letting it through", () => {
    expect(sanitiseFileName("line\nbreak.txt")).toBe("line-break.txt");
    expect(sanitiseFileName("tab\there.txt")).toBe("tab-here.txt");
  });

  it("replaces anything outside Latin-1", () => {
    expect(sanitiseFileName("日本語.txt")).toBe("---.txt");
    expect(sanitiseFileName("résumé.txt")).toBe("r-sum-.txt");
  });
});

describe("sanitiseArchiveEntry", () => {
  it("sanitises each segment and keeps the directory separators", () => {
    expect(sanitiseArchiveEntry("sites/line\nbreak.txt")).toBe("sites/line-break.txt");
  });

  it("is the sanitiser applied segment-wise, not a second rule", () => {
    expect(sanitiseArchiveEntry("日本語/line\nbreak.txt")).toBe("---/line-break.txt");
  });
});
