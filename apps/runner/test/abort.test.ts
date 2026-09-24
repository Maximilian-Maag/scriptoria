import { describe, expect, it } from "vitest";
import type { AbortStage } from "@scriptoria/contracts";
import type { ProcessExit, RunningScript } from "../src/driver/executionTarget";
import { StagedAbort } from "../src/run/abort";

process.env.LOG_LEVEL = "error";
// ADR-003's grace periods, shortened to the point where a test can wait them
// out. The stages themselves are what is asserted, not their durations.
process.env.ABORT_SIGINT_GRACE_MS = "20";
process.env.ABORT_SIGTERM_GRACE_MS = "20";

/**
 * ADR-003's escalation as a thing in itself.
 *
 * The run lifecycle test next door drives this through a PTY; these cases are
 * about the one rule that has nothing to do with a terminal — whether the
 * process is still there when the operator's stop arrives — and they can state
 * it without a database, an ssh2 channel or Redis.
 */
interface FakeScript extends RunningScript {
  signals: AbortStage[];
  /** The process going away, however it went. */
  finish(exit: ProcessExit): void;
}

function script(): FakeScript {
  let finish: (exit: ProcessExit) => void = () => {};
  const exit = new Promise<ProcessExit>((resolve) => {
    finish = resolve;
  });
  const signals: AbortStage[] = [];

  return {
    signals,
    finish,
    onData: () => {},
    write: () => {},
    resize: () => {},
    signal: async (stage) => {
      signals.push(stage);
    },
    exit,
  };
}

/** Lets the escalation reach its next stage, and the exit watcher notice one. */
const settle = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("StagedAbort", () => {
  it("escalates through every stage while the process is still there", async () => {
    const target = script();
    const reporter = new StagedAbort("run", target, async () => {});

    expect(reporter.request()).toBe("requested");
    await settle();

    expect(target.signals).toEqual(["sigint", "sigterm", "sigkill"]);
    expect(reporter.wasSignalled).toBe(true);
    expect(reporter.stage).toBe("sigkill");
  });

  /**
   * The defect this file exists for. The pid file outlives the script itself
   * until the run is wound up, so a signal sent here still finds a process
   * group — and reaches whatever else was left in it, after the run is over.
   */
  it("refuses a stop that arrives once the process has gone", async () => {
    const target = script();
    const reporter = new StagedAbort("run", target, async () => {});

    target.finish({ code: 0, signal: null });
    await settle(5);

    expect(reporter.request()).toBe("too_late");
    await settle();

    expect(target.signals).toEqual([]);
    expect(reporter.wasSignalled).toBe(false);
    expect(reporter.stage).toBeNull();
  });

  it("changes nothing on a second click", async () => {
    const target = script();
    const reporter = new StagedAbort("run", target, async () => {});

    expect(reporter.request()).toBe("requested");
    expect(reporter.request()).toBe("already_requested");
  });

  /**
   * The escalation stops where the process does. A stage reached after the
   * script has ended is a signal to nobody, and the stage it stopped at is what
   * the audit trail is asked to explain afterwards.
   */
  it("stops escalating once the process goes", async () => {
    const target = script();
    const reporter = new StagedAbort("run", target, async () => {});

    reporter.request();
    await settle(5);
    target.finish({ code: 0, signal: null });
    await settle();

    expect(target.signals).toEqual(["sigint"]);
    expect(reporter.stage).toBe("sigint");
  });
});
