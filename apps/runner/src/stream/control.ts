import type Redis from "ioredis";
import { runControlSchema, type RunControl } from "@scriptoria/contracts";
import { blockingConnection, keys } from "../redis";
import { describeError, log } from "../log";

/**
 * The other direction: keystrokes and control messages, from whichever control
 * plane process is holding the browser's socket to the one worker holding this
 * PTY.
 *
 * Two channels rather than one, because they are two different kinds of thing.
 * Stdin is opaque bytes that must not be parsed; control is small structured
 * JSON that must be. Putting them on one channel would mean sniffing a byte
 * stream to decide whether it was meant to be JSON — which is how a script that
 * prints a brace ends up aborting itself.
 */
export class ControlSubscriber {
  private readonly connection: Redis;

  constructor(
    private readonly runId: string,
    handlers: {
      onStdin: (data: Buffer) => void;
      onControl: (message: RunControl) => void;
    },
  ) {
    this.connection = blockingConnection();
    const stdinChannel = keys.runStdin(runId);
    const controlChannel = keys.runControl(runId);

    // `messageBuffer`, not `message`: the stdin channel carries the operator's
    // keystrokes, and ioredis's string variant would decode them (ADR-006).
    this.connection.on("messageBuffer", (channel: Buffer, payload: Buffer) => {
      const name = channel.toString();
      if (name === stdinChannel) {
        handlers.onStdin(payload);
        return;
      }
      if (name !== controlChannel) return;

      const parsed = runControlSchema.safeParse(safeJson(payload));
      if (!parsed.success) {
        log.warn("ignored a malformed control message", { runId, issues: parsed.error.issues });
        return;
      }
      handlers.onControl(parsed.data);
    });

    void this.connection.subscribe(stdinChannel, controlChannel).catch((cause: unknown) => {
      // A run whose stdin never arrives is a run nobody can answer, so this is
      // an error rather than a warning — but it does not stop the script, which
      // may well be one of the non-interactive majority.
      log.error("could not subscribe to the run's channels", {
        runId,
        error: describeError(cause),
      });
    });
  }

  close(): void {
    this.connection.disconnect();
    log.trace("control subscriber closed", { runId: this.runId });
  }
}

function safeJson(payload: Buffer): unknown {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
}
