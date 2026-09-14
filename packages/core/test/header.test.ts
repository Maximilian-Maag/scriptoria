import { describe, expect, it } from "vitest";
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
});
