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

export class StagedAbort {
  private requested = false;
  private reachedStage: AbortStage | null = null;

  constructor(
    private readonly runId: string,
    private readonly script: RunningScript,
    private readonly onStage: StageListener,
  ) {}

  /** True once an abort has been asked for — this is what makes the run `aborted`. */
  get wasRequested(): boolean {
    return this.requested;
  }

  /** How far the escalation actually had to go. Null when nothing was signalled. */
  get stage(): AbortStage | null {
    return this.reachedStage;
  }

  /**
   * Idempotent: a second request while the escalation is running changes
   * nothing. An operator clicking stop twice is an operator who wants it to
   * stop, not one who wants it killed sooner.
   */
  request(): void {
    if (this.requested) return;
    this.requested = true;
    void this.escalate();
  }

  private async escalate(): Promise<void> {
    const config = loadRunnerConfig();
    const stages: [AbortStage, number][] = [
      ["sigint", config.ABORT_SIGINT_GRACE_MS],
      ["sigterm", config.ABORT_SIGTERM_GRACE_MS],
      ["sigkill", 0],
    ];

    for (const [stage, graceMs] of stages) {
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
