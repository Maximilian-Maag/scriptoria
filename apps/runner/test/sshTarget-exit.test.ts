import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import { SshExecutionTarget } from "../src/driver/sshTarget";
import type { StartSpec } from "../src/driver/executionTarget";

/**
 * A peer whose `exit` arrives before the caller's `await` resumes.
 *
 * This is the timing that matters and not an invented one: ssh2 calls the exec
 * callback when the channel opens, then parses the packet carrying `exit` in the
 * same turn, so an `await` on that callback can resume *after* the event has
 * been emitted. Against OpenSSH over a real socket the two usually interleave
 * favourably, which is why the defect was invisible: it needed a peer that
 * answers without a round trip.
 *
 * `close` is deferred by a macrotask so that the assertion below is made against
 * a resolved promise in both the fixed and the broken ordering — otherwise the
 * broken one hangs instead of failing, and a hang says less than a diff.
 */
function peer(exit: { code: number | null; signal?: string }): Client {
  const exec = (
    _command: string,
    ...rest: unknown[]
  ): EventEmitter => {
    const callback = rest[rest.length - 1] as (
      error: Error | null,
      stream: EventEmitter | null,
    ) => void;

    const stream = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      write: () => boolean;
      setWindow: () => void;
      resume: () => void;
    };
    stream.stderr = new EventEmitter();
    stream.write = () => true;
    stream.setWindow = () => {};
    stream.resume = () => {};

    callback(null, stream);
    stream.emit("exit", exit.code, exit.signal);
    setImmediate(() => stream.emit("close"));
    return stream;
  };

  return { exec, end: () => {} } as unknown as Client;
}

const ADDRESS = { host: "vm1.example.test", port: 22, username: "scriptoria" };

function spec(): StartSpec {
  return {
    runId: randomUUID(),
    absolutePath: "/opt/scriptoria/scripts/nightly.sh",
    fileName: "nightly.sh",
    workingDirectory: "/opt/scriptoria",
    executable: true,
    cols: 80,
    rows: 24,
  };
}

describe("SshExecutionTarget.start", () => {
  it("reports the exit code of a run that succeeded", async () => {
    const target = new SshExecutionTarget(ADDRESS, peer({ code: 0 }));
    const running = await target.start(spec());

    // The whole point of the fix: a null code here is what turned every clean
    // run into `failed` / `exit_code` in the audit trail (FA-10.2, FA-12.2).
    await expect(running.exit).resolves.toEqual({ code: 0, signal: null });
  });

  it("still reports a non-zero exit code, rather than a missing one", async () => {
    const target = new SshExecutionTarget(ADDRESS, peer({ code: 3 }));
    const running = await target.start(spec());

    await expect(running.exit).resolves.toEqual({ code: 3, signal: null });
  });

  it("keeps the signal when the peer reports one instead of a code", async () => {
    const target = new SshExecutionTarget(ADDRESS, peer({ code: null, signal: "SIGKILL" }));
    const running = await target.start(spec());

    // `execute` reads a signal as connection_lost, so it has to survive.
    await expect(running.exit).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });
});
