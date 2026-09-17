import { resolve } from "node:path";

/** Where the setup records the runner it started, for the teardown to stop. */
export const RUNNER_PID_FILE = resolve(import.meta.dirname, "../.playwright/runner.pid");
