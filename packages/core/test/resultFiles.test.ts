import { describe, expect, it } from "vitest";
import {
  MAX_PREVIEW_BYTES,
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
    // A trailing dot is a name with no extension, not an empty one.
    expect(contentTypeFor("report.")).toBe("application/octet-stream");
    expect(contentTypeFor("")).toBe("application/octet-stream");
  });

  it("gives a dotfile no extension even when its suffix is a known type", () => {
    // ".csv" is a file called ".csv", not a CSV: the dot is the first character.
    expect(contentTypeFor(".csv")).toBe("application/octet-stream");
    expect(contentTypeFor(".json")).toBe("application/octet-stream");
  });

  it("is case-insensitive, because a name comes off the VM as it was written there", () => {
    expect(contentTypeFor("ARCHIVE.CSV")).toBe("text/csv");
    expect(contentTypeFor("Report.Xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  /**
   * Every entry in the table, named once. The table is what the result view's
   * preview and copy button key off, and a wrong row is invisible until a file
   * of that kind is opened — one asserted per extension is the only way the
   * table can be edited with any confidence.
   */
  it("maps every extension it claims to know", () => {
    const expected: Record<string, string> = {
      csv: "text/csv",
      tsv: "text/tab-separated-values",
      txt: "text/plain",
      log: "text/plain",
      json: "application/json",
      xml: "application/xml",
      yaml: "application/yaml",
      yml: "application/yaml",
      md: "text/markdown",
      html: "text/html",
      htm: "text/html",
      conf: "text/plain",
      cfg: "text/plain",
      ini: "text/plain",
      pdf: "application/pdf",
      zip: "application/zip",
      gz: "application/gzip",
      tar: "application/x-tar",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
    };
    for (const [extension, type] of Object.entries(expected)) {
      expect(contentTypeFor(`result.${extension}`)).toBe(type);
    }
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

  it("previews a file exactly at the cap and refuses the byte after it", () => {
    // The boundary is the whole decision: 256 KiB is inlined, one byte more is not.
    expect(isPreviewable("exactly.log", MAX_PREVIEW_BYTES)).toBe(true);
    expect(isPreviewable("one-more.log", MAX_PREVIEW_BYTES + 1)).toBe(false);
  });

  it("previews json and xml, which are text with a vendor type", () => {
    expect(isPreviewable("inventory.json", 1024)).toBe(true);
    expect(isPreviewable("inventory.xml", 1024)).toBe(true);
    expect(isPreviewable("images.yaml", 1024)).toBe(true);
  });

  it("never previews a binary, whatever its size", () => {
    expect(isPreviewable("scan.pdf", 16)).toBe(false);
    expect(isPreviewable("bundle.zip", 16)).toBe(false);
    expect(isPreviewable("dump", 16)).toBe(false);
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

  it("drops only the last extension, so a dotted name keeps its own", () => {
    expect(archiveFileName("nightly-results.tar.gz", new Date("2026-03-04T09:15:30Z"))).toBe(
      "nightly-results.tar-2026-03-04-09-15-30.zip",
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
