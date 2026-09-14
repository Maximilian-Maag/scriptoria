import { z } from "zod";
import { defineConfig, intFromEnv, boolFromEnv, nonEmpty } from "./load";
import { sharedSchema } from "./shared";
import { redisSchema } from "./redis";

export const runnerSchema = sharedSchema.merge(redisSchema).extend({
  /**
   * One worker claims one run at a time per slot (see the Job Consumer in the
   * model). Raising this raises the number of concurrent PTYs one process holds,
   * not the number of processes — which is the knob you want, because the SSH
   * connections are the expensive part, not the CPU.
   */
  RUNNER_CONCURRENCY: intFromEnv({ min: 1, max: 64 }).default(4),

  /** Identifies this worker in the run record, so an orphan is attributable. */
  RUNNER_ID: z.string().trim().default(""),

  SSH_PRIVATE_KEY_PATH: nonEmpty.default("infra/sshd/keys/id_ed25519"),
  SSH_PRIVATE_KEY_PASSPHRASE: z.string().default(""),

  /**
   * Host keys are pinned. An unpinned SSH client in a zone whose whole point is
   * that it is isolated would be defeating the isolation from the inside.
   */
  SSH_KNOWN_HOSTS_PATH: nonEmpty.default("infra/sshd/known_hosts"),
  /** Dev only, against a fixture whose host key is regenerated on every build. */
  SSH_SKIP_HOST_KEY_VERIFICATION: boolFromEnv.default("false"),

  SSH_CONNECT_TIMEOUT_MS: intFromEnv({ min: 1000 }).default(15_000),
  SSH_KEEPALIVE_INTERVAL_MS: intFromEnv({ min: 0 }).default(15_000),

  /** The PTY the scripts get. 80x24 is the fallback until the client reports. */
  PTY_COLS: intFromEnv({ min: 20, max: 500 }).default(80),
  PTY_ROWS: intFromEnv({ min: 5, max: 200 }).default(24),

  /**
   * ADR-003, staged abort: SIGINT, then SIGTERM, then SIGKILL, with a pause
   * between the stages. The pauses are the decision — a script that is mid-write
   * to a firewall deserves the chance to unwind before it is killed outright.
   */
  ABORT_SIGINT_GRACE_MS: intFromEnv({ min: 0 }).default(5_000),
  ABORT_SIGTERM_GRACE_MS: intFromEnv({ min: 0 }).default(10_000),
});

export const loadRunnerConfig = defineConfig("runner", runnerSchema);
export type RunnerConfig = z.infer<typeof runnerSchema>;
