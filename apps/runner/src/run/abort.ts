import type { AbortStage } from "@scriptoria/contracts";
import { loadRunnerConfig } from "@scriptoria/config";
import type { RunningScript } from "../driver/executionTarget";
import { describeError, log } from "../log";

/**
 * ADR-003's escalation: SIGINT, then SIGTERM, then SIGKILL, with a pause
 * between the stages, to the process group rather than the channel.
 *
 * The pauses are the decision, not an implementation detail. SIGINT is what
 * Ctrl-C would have done, which is what the scripts' own confirmation prompts
 * already expect — so the first stage usually ends the run the way the script
 * itself would have ended it. A script mid-write to a firewall then gets a
 * further grace period before the platform stops being polite.
 *
 * The platform does not roll anything back and does not pretend to. What it
 * guarantees is that each stage is recorded, so a human can work out where the
 * run stopped.
 */

export type StageListener = (stage: AbortStage) => void | Promise<void>;

/**
 * What a stop request did, because "asked" and "acted on" are two different
 * facts and the run's outcome depends on the second one (FA-08.1).
 */
export type AbortRequestOutcome =
  /** Acted on: a process that was still there is being asked to stop. */
  | "requested"
  /** A second click while the escalation is already under way. Changes nothing. */
  | "already_requested"
  /** The script had already exited. Nothing was signalled, and nothing will be. */
  | "too_late";

export class StagedAbort {
  private requested = false;
  private reachedStage: AbortStage | null = null;
  private exited = false;

  constructor(
    private readonly runId: string,
    private readonly script: RunningScript,
    private readonly onStage: StageListener,
  ) {
    // Watched rather than awaited: whether the process is still there decides
    // what a stop request may do, and that answer has to be available at the
    // moment the request arrives.
    void script.exit.then(() => {
      this.exited = true;
    });
  }

  /**
   * True once a signal was actually sent, to a process that was still there.
   *
   * This — not the request — is what makes a run `aborted`. An operator who
   * pressed stop a moment after the script finished did not stop it, and a run
   * that exited 0 did not fail because somebody asked afterwards: FA-10.2's
   * *last successful* would be rewritten by a late click, which is a lie about
   * the script, and ADR-003 reserves `aborted` for a run a human really stopped.
   */
  get wasSignalled(): boolean {
    return this.reachedStage !== null;
  }

  /** How far the escalation actually had to go. Null when nothing was signalled. */
  get stage(): AbortStage | null {
    return this.reachedStage;
  }

  /**
   * Idempotent: a second request while the escalation is running changes
   * nothing. An operator clicking stop twice is an operator who wants it to
   * stop, not one who wants it killed sooner.
   *
   * Inert once the process is gone, and that is why this reports what it did
   * rather than returning nothing. The pid file outlives the script until the
   * run is wound up, so `kill -INT -<pid>` here still finds a process group —
   * and signals whatever else was left in it, after the run is over and the only
   * thing left to do with the outcome is to record it.
   */
  request(): AbortRequestOutcome {
    if (this.exited) return "too_late";
    if (this.requested) return "already_requested";
    this.requested = true;
    void this.escalate();
    return "requested";
  }

  private async escalate(): Promise<void> {
    const config = loadRunnerConfig();
    const stages: [AbortStage, number][] = [
      ["sigint", config.ABORT_SIGINT_GRACE_MS],
      ["sigterm", config.ABORT_SIGTERM_GRACE_MS],
      ["sigkill", 0],
    ];

    for (const [stage, graceMs] of stages) {
      // Re-checked per stage rather than once at the door: the process can go
      // between the request and the signal, and a script that finishes on its
      // own while a stop is in flight must be recorded as the run it was.
      if (this.exited) return;

      try {
        await this.script.signal(stage);
        this.reachedStage = stage;
        await this.onStage(stage);
      } catch (cause) {
        log.warn("could not signal the process group", {
          runId: this.runId,
          stage,
          error: describeError(cause),
        });
      }

      // SIGKILL is the last stage: there is nothing to wait for afterwards.
      if (graceMs === 0) return;
      if (await this.exitedWithin(graceMs)) return;
    }
  }

  /** Resolves true if the process is gone before the grace period is up. */
  private exitedWithin(graceMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      void this.script.exit.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
