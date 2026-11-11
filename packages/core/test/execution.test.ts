import { describe, expect, it } from "vitest";
import {
  CRONTAB_READ_COMMAND,
  CRONTAB_WRITE_COMMAND,
  PID_DIR,
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
  /**
   * Every entry in the table, because a script that is handed the wrong
   * interpreter fails at its first line — and the failure looks like the
   * script's fault, on a machine the operator is not sitting at.
   */
  it("names the interpreter for every extension it claims to know", () => {
    const expected: Record<string, string> = {
      py: "python3",
      pl: "perl",
      rb: "ruby",
      ksh: "ksh",
      zsh: "zsh",
    };
    for (const [extension, interpreter] of Object.entries(expected)) {
      expect(interpreterFor(`collect.${extension}`)).toBe(interpreter);
    }
  });

  it("treats a dotfile as having no extension at all", () => {
    // A leading dot is not a separator: ".bashrc" is a name, not a "bashrc" file.
    expect(interpreterFor(".bashrc")).toBe("bash");
    expect(interpreterFor("notes.")).toBe("bash");
    // Even when the suffix happens to name an interpreter: ".py" is a file
    // called ".py", and running it with python3 is an accident.
    expect(interpreterFor(".py")).toBe("bash");
  });

  it("is case-insensitive, because a name comes off the VM as it was written there", () => {
    expect(interpreterFor("collect.PY")).toBe("python3");
  });

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

describe("the commands the target answers", () => {
  /**
   * These two strings ARE the protocol with the script VM (ADR-001's closed
   * vocabulary): the target matches on them, and a deployment where the runner
   * and the target disagree sends a command that silently does nothing. Pinned
   * as text for that reason, not because the constants need testing.
   */
  it("reads the crontab, and writes it from stdin", () => {
    expect(CRONTAB_READ_COMMAND).toBe("crontab -l");
    expect(CRONTAB_WRITE_COMMAND).toBe("crontab -");
  });

  it("keeps every run's pid file in one directory, named by the run", () => {
    expect(PID_DIR).toBe("/tmp/.scriptoria");
    expect(pidFilePath(RUN)).toBe("/tmp/.scriptoria/3f1b0a1e-0000-4000-8000-000000000001.pid");
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
