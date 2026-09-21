import { describe, expect, it } from "vitest";
import {
  SCRIPT_DESCRIPTION_MAX_LENGTH,
  SCRIPT_TITLE_MAX_LENGTH,
  scriptHeaderSchema,
} from "@scriptoria/contracts";
import { parseScriptHeader } from "../src/header";

/**
 * ADR-004's own example is the first fixture, on purpose: if the parser and the
 * decision record disagree, one of them is wrong and this is where it shows.
 */
const ADR_EXAMPLE = `#!/usr/bin/env bash
# scriptoria:title        Interface inventory across all sites
# scriptoria:description  Reads the interface configuration of every device in the
#                  branch network and writes one Excel workbook per site.
# scriptoria:criticality  read-only          # read-only | modifying
# scriptoria:interactive  false              # does the script prompt on stdin
# scriptoria:outputs      /opt/scriptoria/export    # where results land

set -euo pipefail
echo hello
`;

describe("parseScriptHeader", () => {
  it("reads the block from ADR-004 exactly as the ADR writes it", () => {
    const header = parseScriptHeader(ADR_EXAMPLE);

    expect(header).not.toBeNull();
    expect(header?.title).toBe("Interface inventory across all sites");
    expect(header?.description).toBe(
      "Reads the interface configuration of every device in the branch network and writes one Excel workbook per site.",
    );
    expect(header?.criticality).toBe("read-only");
    expect(header?.interactive).toBe(false);
    expect(header?.outputs).toBe("/opt/scriptoria/export");
  });

  it("returns null for a script with no block, rather than throwing", () => {
    expect(parseScriptHeader("#!/bin/sh\necho hi\n")).toBeNull();
  });

  it("keeps a script with an unreadable criticality in the catalog, undeclared", () => {
    const header = parseScriptHeader("# scriptoria:title Thing\n# scriptoria:criticality frobnicate\n");
    expect(header?.title).toBe("Thing");
    // Undeclared, not rejected. ADR-004 has an answer for undeclared; it has no
    // answer for a script that vanished from the list.
    expect(header?.criticality).toBeUndefined();
  });

  it("keeps unknown keys instead of dropping them", () => {
    const header = parseScriptHeader("# scriptoria:title T\n# scriptoria:owner netops@example.test\n");
    expect(header?.extra).toEqual({ owner: "netops@example.test" });
  });

  it("stops at the first non-comment line", () => {
    const header = parseScriptHeader("# scriptoria:title Real\nset -e\n# scriptoria:criticality modifying\n");
    expect(header?.title).toBe("Real");
    expect(header?.criticality).toBeUndefined();
  });

  it("never reads past the first 100 lines", () => {
    const padding = "# filler\n".repeat(120);
    expect(parseScriptHeader(`${padding}# scriptoria:title Buried\n`)).toBeNull();
  });

  it("accepts the truthy spellings people actually write", () => {
    for (const value of ["true", "yes", "1", "On"]) {
      expect(parseScriptHeader(`# scriptoria:interactive ${value}\n`)?.interactive).toBe(true);
    }
    for (const value of ["false", "no", "0", "Off"]) {
      expect(parseScriptHeader(`# scriptoria:interactive ${value}\n`)?.interactive).toBe(false);
    }
  });

  it("ignores an outputs path that is relative or contains ..", () => {
    expect(parseScriptHeader("# scriptoria:outputs export\n")?.outputs).toBeUndefined();
    expect(parseScriptHeader("# scriptoria:outputs /opt/../etc\n")?.outputs).toBeUndefined();
  });

  /**
   * The bug this file gained these tests for: a script whose header documents
   * itself in prose *under* a key. Folding that prose into the key above it made
   * `criticality` unreadable, and an unreadable criticality is the one parser
   * failure with a safety consequence — ADR-003 gates a modifying script behind a
   * confirmation, and `unknown` is treated as modifying.
   */
  it("does not fold an indented comment into a single-token key", () => {
    const header = parseScriptHeader(
      [
        "# scriptoria:title        Rollout",
        "# scriptoria:criticality  read-only",
        "#  the nightly sweep only reads, it never writes",
        "# scriptoria:outputs      /opt/scriptoria/export",
      ].join("\n") + "\n",
    );

    expect(header?.criticality).toBe("read-only");
    expect(header?.outputs).toBe("/opt/scriptoria/export");
    expect(header?.title).toBe("Rollout");
  });

  it("still folds a continuation into a multi-line description", () => {
    const header = parseScriptHeader(
      [
        "# scriptoria:title T",
        "# scriptoria:description First line",
        "#                        second line",
        "# scriptoria:criticality modifying",
      ].join("\n") + "\n",
    );

    expect(header?.description).toBe("First line second line");
    expect(header?.criticality).toBe("modifying");
  });

  it("truncates an over-long title rather than losing the header with it", () => {
    const header = parseScriptHeader(
      `# scriptoria:title ${"t".repeat(250)}\n# scriptoria:criticality read-only\n`,
    );

    expect(header?.title).toHaveLength(SCRIPT_TITLE_MAX_LENGTH);
    // The point of truncating: the declaration next to it survives.
    expect(header?.criticality).toBe("read-only");
  });

  /**
   * The parser's output is fed straight back into `scriptHeaderSchema` by
   * catalogService, which answers a failed header with no header at all. So the
   * two have to agree, and this is where they would stop agreeing.
   */
  it("always produces a header its own contract accepts", () => {
    const hostile = [
      "# scriptoria:title " + "t".repeat(300),
      "# scriptoria:description " + "d".repeat(5_000),
      "# scriptoria:criticality  read-only",
      "#  a stray indented line",
      "# scriptoria:interactive maybe",
      "# scriptoria:outputs /opt/export",
      "# scriptoria:owner netops@example.test",
    ].join("\n");

    const header = parseScriptHeader(`${hostile}\n`);
    const parsed = scriptHeaderSchema.safeParse(header);

    expect(parsed.success).toBe(true);
    expect(header?.description).toHaveLength(SCRIPT_DESCRIPTION_MAX_LENGTH);
    expect(header?.criticality).toBe("read-only");
    expect(header?.extra).toEqual({ owner: "netops@example.test" });
  });
});
