/**
 * The end-to-end suite's own Playwright configuration.
 *
 * Run it through the Makefile — `make test-e2e` — which is the same command CI
 * runs, so a green run here and a green run there mean the same thing.
 *
 * **Prerequisites, all of them already on the host:**
 *
 *   make dev            postgres, redis, the directory fixture, the script-VM fixture
 *   make fixtures-key   the SSH keypair the runner presents to the fixture
 *   make db-migrate     the schema
 *   make db-seed        the root group and the reference area
 *   pnpm --filter e2e browsers    Chromium, once per machine
 *
 * The three application processes are started here rather than expected to be
 * running: a suite that silently tests whatever happens to be listening on
 * :3000 is a suite that reports success about somebody's stale build. An
 * already-running stack is reused outside CI, where a developer has `make run`
 * open in another terminal and would rather not have it killed.
 */
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, BACKEND_ORIGIN } from "./src/env";

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./src/global-setup.ts",

  /**
   * Serial, and deliberately.
   *
   * Every spec drives the same estate: one area, one script-VM fixture, one
   * crontab, one export directory. Two specs in parallel would be editing one
   * crontab and reading one export directory at the same time, and the failures
   * that produces are the kind that pass on a rerun — which is worse than slow.
   */
  workers: 1,
  fullyParallel: false,

  // A focused `test.only` must never reach a merge.
  forbidOnly: CI,

  // One retry in CI only: a flake in a distributed CI runner is common enough
  // to be worth answering, and `trace` below is what makes it answerable.
  retries: CI ? 1 : 0,

  timeout: 90_000,
  expect: { timeout: 15_000 },

  reporter: CI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // The interface is German-tolerant by design (ADR-006) but its own wording
    // is British English, so the browser's locale must not be the variable that
    // decides what a date or a "last successful" looks like.
    locale: "en-GB",
    timezoneId: "Europe/Berlin",
    // FA-09.4 is "copy the content to transfer it to another system without a
    // download", and a preview's Copy button is refused without this. Granted
    // here rather than worked around, so the spec exercises the real clipboard
    // instead of asserting that the refusal banner appeared.
    permissions: ["clipboard-read", "clipboard-write"],
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],

  webServer: {
    // All three at once, exactly as `make run` starts them. The runner has no
    // listening port, so the readiness signal is the frontend's — the runner is
    // then proven by the first spec that queues work and watches it run.
    command: "pnpm --parallel --filter frontend --filter backend --filter runner dev",
    cwd: "..",
    url: `${BASE_URL}/login`,
    reuseExistingServer: !CI,
    timeout: 240_000,
    env: {
      // The child processes inherit this suite's environment, which is how an
      // operator points a run at a deployment: set DATABASE_URL, REDIS_URL,
      // LDAP_URL and the rest before invoking the suite. The two below are set
      // explicitly because a Next.js dev server started with NODE_ENV=test
      // behaves differently from the one the deployment runs.
      ...process.env,
      NODE_ENV: "development",
      BACKEND_PUBLIC_ORIGIN: BACKEND_ORIGIN,
    },
  },
});
