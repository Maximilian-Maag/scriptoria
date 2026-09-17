import { loadRunnerConfig } from "@scriptoria/config";
import { keys, redis } from "../redis";
import { describeError, log } from "../log";

/**
 * ADR-006's producer: the PTY's raw bytes, appended to one capped Redis stream
 * per run.
 *
 * The runner does not hold the browser's socket. It writes here and the control
 * plane's gateway reads from here, which is what lets a browser reload, a brief
 * network drop or a redeploy of the web tier happen without the script noticing.
 *
 * Nothing in this file decodes anything. The bytes that came off the PTY are
 * the bytes that go into the stream (ADR-006).
 */
export class StreamPublisher {
  private readonly key: string;
  /** Appends are chained rather than awaited by the caller: order is the point. */
  private tail: Promise<void> = Promise.resolve();
  private latestId: string | null = null;
  private failed = false;

  constructor(private readonly runId: string) {
    this.key = keys.runStream(runId);
  }

  get lastStreamId(): string | null {
    return this.latestId;
  }

  /**
   * Queues one chunk. Deliberately not awaited by the PTY handler: awaiting
   * there would make the script's own output rate depend on a round trip to
   * Redis, and a script that writes a megabyte would stall mid-write.
   */
  publish(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const config = loadRunnerConfig();

    this.tail = this.tail.then(async () => {
      try {
        const id = await redis().xadd(
          this.key,
          "MAXLEN",
          "~",
          config.STREAM_MAXLEN,
          "*",
          "d",
          chunk,
        );
        if (id) this.latestId = id;
      } catch (cause) {
        // Once, not once per chunk: a Redis outage during a run would otherwise
        // produce a log line for every write of a script that is still running.
        if (!this.failed) {
          this.failed = true;
          log.error("could not append to the run stream", {
            runId: this.runId,
            error: describeError(cause),
          });
        }
      }
    });
  }

  /** Waits for everything queued so far to have reached Redis. */
  async flush(): Promise<void> {
    await this.tail;
  }

  /**
   * Gives the finished run's stream a life of its own.
   *
   * It outlives the run so that a browser reconnecting after the process exited
   * still gets the tail rather than an empty terminal; it does not outlive it
   * forever, because the durable copy of the scrollback is the transcript in
   * Postgres (FA-07.2).
   */
  async expire(): Promise<void> {
    await this.flush();
    try {
      await redis().expire(this.key, loadRunnerConfig().STREAM_TTL_SECONDS);
    } catch (cause) {
      log.warn("could not set the stream's expiry", {
        runId: this.runId,
        error: describeError(cause),
      });
    }
  }
}
