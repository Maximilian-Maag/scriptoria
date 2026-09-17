import type Redis from "ioredis";
import { runJobSchema } from "@scriptoria/contracts";
import { blockingConnection, keys, redis } from "../redis";
import { executeRun } from "../run/execute";
import { describeError, log } from "../log";

/**
 * One slot: blocks on the queue, claims what it finds, runs it, repeats.
 *
 * `RUNNER_CONCURRENCY` of these run side by side in one process. The knob is
 * PTYs per process rather than processes, because the SSH connections are the
 * expensive part — and because O-7 still has the concurrency question open at
 * the *script VM's* end, where the scripts were written for sequential manual
 * use.
 */

/** How long a claim survives without renewal. Longer than a renewal interval. */
const CLAIM_TTL_SECONDS = 60;

/**
 * How long a blocking pop waits before coming back empty. Not a poll interval —
 * it is how quickly a slot notices that the process is shutting down.
 */
const POP_TIMEOUT_SECONDS = 5;

export class QueueConsumer {
  private readonly connection: Redis = blockingConnection();
  private running = false;
  private active = 0;

  constructor(private readonly workerId: string) {}

  get activeRuns(): number {
    return this.active;
  }

  async start(slots: number): Promise<void> {
    this.running = true;
    log.info("consuming the run queue", { workerId: this.workerId, slots });
    await Promise.all(Array.from({ length: slots }, (_, slot) => this.loop(slot)));
  }

  /** Stops taking new work. Runs already in flight are left to finish. */
  stop(): void {
    this.running = false;
  }

  close(): void {
    this.connection.disconnect();
  }

  private async loop(slot: number): Promise<void> {
    while (this.running) {
      try {
        const popped = await this.connection.brpop(keys.runQueue, POP_TIMEOUT_SECONDS);
        if (!popped) continue;

        const [, payload] = popped;
        const job = runJobSchema.safeParse(safeJson(payload));
        if (!job.success) {
          log.warn("discarded a malformed job", { payload, issues: job.error.issues });
          continue;
        }

        await this.claimAndRun(job.data.runId);
      } catch (cause) {
        if (!this.running) return;
        // A Redis blip must not end the slot — a runner that quietly stops
        // consuming looks exactly like a platform where nothing starts.
        log.error("queue slot recovering", { slot, error: describeError(cause) });
        await sleep(1000);
      }
    }
  }

  /**
   * The claim, and the reason it exists: two workers popping the same job is
   * impossible with one queue, but a job *requeued* after a worker died is not.
   * `NX` makes the second claim fail rather than open a second PTY on a script
   * that is already modifying things.
   */
  private async claimAndRun(runId: string): Promise<void> {
    const key = keys.runClaim(runId);
    const claim = await redis().set(key, this.workerId, "EX", CLAIM_TTL_SECONDS, "NX");
    if (claim !== "OK") {
      log.info("another worker holds this run", { runId });
      return;
    }

    this.active += 1;
    try {
      await executeRun(runId, {
        workerId: this.workerId,
        renewClaim: async () => {
          await redis().set(key, this.workerId, "EX", CLAIM_TTL_SECONDS);
        },
      });
    } finally {
      this.active -= 1;
      await redis().del(key).catch(() => {});
    }
  }
}

function safeJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
