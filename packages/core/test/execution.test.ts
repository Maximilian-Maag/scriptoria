import { describe, expect, it } from "vitest";
import {
  abortCommand,
  cleanupCommand,
  executionCommand,
  interpreterFor,
  pidFilePath,
  shellQuote,
} from "../src/execution";

const RUN = "3f1b0a1e-0000-4000-8000-000000000001";

describe("shellQuote", () => {
  it("wraps a plain path", () => {
    expect(shellQuote("/opt/scriptoria/scripts")).toBe("'/opt/scriptoria/scripts'");
  });

  it("survives a quote in the path", () => {
    // A directory with an apostrophe in it is not exotic, and a quoting bug
    // here is a command that runs something other than what it says.
    expect(shellQuote("/opt/o'brien")).toBe("'/opt/o'\\''brien'");
  });
});

describe("interpreterFor", () => {
  it("reads the extension, and falls back to a shell that runs both", () => {
    expect(interpreterFor("collect.py")).toBe("python3");
    expect(interpreterFor("rollout.sh")).toBe("bash");
    // Unknown and undecorated both land on bash rather than dash: a script
    // written for bash fails under sh as a syntax error partway through.
    expect(interpreterFor("report")).toBe("bash");
    expect(interpreterFor("weird.frobnicate")).toBe("bash");
  });
});

describe("executionCommand", () => {
  const base = {
    runId: RUN,
    absolutePath: "/opt/scriptoria/scripts/site-rollout.sh",
    fileName: "site-rollout.sh",
    workingDirectory: "/opt/scriptoria/scripts",
    executable: true,
  };

  it("execs the script itself when it can start on its own shebang", () => {
    const command = executionCommand(base);
    expect(command).toContain("exec '/opt/scriptoria/scripts/site-rollout.sh'");
    expect(command).not.toContain("bash ");
  });

  it("names an interpreter only when the executable bit is missing", () => {
    const command = executionCommand({ ...base, executable: false });
    expect(command).toContain("exec bash '/opt/scriptoria/scripts/site-rollout.sh'");
  });

  it("records the pid before it execs, so the pid is the process group", () => {
    // ADR-003 signals the process group, and the group id is the pid of the
    // shell that becomes the script. Recording it after the exec is impossible,
    // which is why the order in this command is the whole design.
    const command = executionCommand(base);
    const pidWrite = command.indexOf(pidFilePath(RUN));
    const exec = command.indexOf("exec ");
    expect(pidWrite).toBeGreaterThan(-1);
    expect(pidWrite).toBeLessThan(exec);
  });

  it("starts the script in its own directory (FA-05.3)", () => {
    expect(executionCommand(base)).toContain("cd '/opt/scriptoria/scripts'");
  });
});

describe("abortCommand", () => {
  it("signals the process group, not the process", () => {
    // The minus sign is the entire point: a script that spawned ssh, curl and
    // three subshells has to stop, not orphan them.
    for (const signal of ["INT", "TERM", "KILL"] as const) {
      expect(abortCommand(RUN, signal)).toContain(`kill -${signal} "-$pid"`);
    }
  });

  it("does nothing when the pid file is not there", () => {
    expect(abortCommand(RUN, "INT")).toContain(`[ -n "$pid" ]`);
  });
});

describe("cleanupCommand", () => {
  it("removes only this run's pid file", () => {
    expect(cleanupCommand(RUN)).toBe(`rm -f '${pidFilePath(RUN)}'`);
  });
});
