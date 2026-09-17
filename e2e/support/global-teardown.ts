import { existsSync, readFileSync, rmSync } from "node:fs";
import { RUNNER_PID_FILE } from "./paths";

/**
 * Stops the runner the setup started. It is detached — it has to be, or it
 * would die with the setup process before a single test ran — so nothing else
 * would ever reap it, and a suite that leaves a runner behind poisons the next
 * one: two runners racing for the same queue is the hardest kind of flake to
 * read, because both are behaving correctly.
 */
export default function globalTeardown(): void {
  if (!existsSync(RUNNER_PID_FILE)) return;

  const pid = Number(readFileSync(RUNNER_PID_FILE, "utf8").trim());
  rmSync(RUNNER_PID_FILE, { force: true });
  if (!Number.isInteger(pid)) return;

  try {
    // Negative pid: the whole process group. pnpm starts the runner as a child
    // of its own, and killing only the pnpm process would orphan the runner.
    process.kill(-pid, "SIGTERM");
  } catch {
    // Already gone. Nothing to do, and nothing worth failing a green run over.
  }
}
