import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseScriptHeader } from "../src/header";

/**
 * The template shipped in `docs/guides/script-vm.md`, read by the platform's own parser.
 *
 * A copy-me example is documentation that people paste into a script VM, so the one thing it
 * must not do is drift from the parser that will read it: a key renamed in ADR-004, a value
 * shape the parser stops accepting, and the guide would be teaching people to write headers
 * the catalog then shows as *undeclared*. This is a cheap way to make the example part of the
 * suite instead of part of the prose.
 */
const SOURCE = readFileSync(
  new URL("../../../docs/guides/examples/reference-script.sh", import.meta.url),
  "utf8",
);

describe("the reference script in docs/guides", () => {
  it("parses, and declares what the guide tells people to declare", () => {
    expect(parseScriptHeader(SOURCE)).toMatchObject({
      title: "Reference script (template)",
      criticality: "read-only",
      interactive: false,
      outputs: "/opt/scriptoria/export",
    });
  });

  it("puts the header where the parser looks — the block is inside the first 100 lines", () => {
    const header = parseScriptHeader(SOURCE);
    expect(header?.description, "the description survives as one line").toContain(
      "Copy-me template",
    );
  });

  it("starts with a shebang, because the platform runs the file directly", () => {
    expect(SOURCE.split("\n")[0]).toBe("#!/usr/bin/env bash");
  });

  it("traps the two signals the platform escalates through (ADR-003)", () => {
    expect(SOURCE).toContain("trap ");
    expect(SOURCE).toMatch(/trap '[^']*' INT TERM/);
  });
});
