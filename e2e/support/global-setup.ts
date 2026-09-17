import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stackEnv } from "../playwright.config";
import { RUNNER_PID_FILE } from "./paths";

/**
 * Brings the e2e database up to date and starts the runner.
 *
 * The two web tiers are Playwright's job (`webServer` in the config); the runner
 * is not, because Playwright decides a server is ready by polling a URL and the
 * runner listens on nothing. Without it every run in this suite would sit in
 * `queued` forever, which is a failure that looks like a timeout and reads like
 * a flake.
 */

const root = resolve(import.meta.dirname, "../..");

function run(what: string, args: string[]): void {
  const result = spawnSync("pnpm", args, { cwd: root, env: stackEnv, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `${what} failed (exit ${result.status}). Is the dev stack up? ` +
        "The suite needs `make dev` for Postgres, Redis, the directory and the sshd fixture, " +
        "and `make test-db` for the scriptoria_e2e database.",
    );
  }
}

export default function globalSetup(): void {
  // Both are idempotent, so this is the same on a fresh database and on the
  // hundredth run against an existing one.
  run("migrate", ["--filter", "@scriptoria/db", "db:migrate"]);
  run("seed", ["--filter", "@scriptoria/db", "db:seed"]);

  const runner = spawn("pnpm", ["--filter", "runner", "dev"], {
    cwd: root,
    env: stackEnv,
    stdio: "ignore",
    detached: true,
  });
  runner.unref();

  if (!runner.pid) throw new Error("the runner did not start");

  mkdirSync(resolve(import.meta.dirname, "../.playwright"), { recursive: true });
  writeFileSync(RUNNER_PID_FILE, String(runner.pid), "utf8");
}
