import { defineConfig, devices } from "@playwright/test";
import { loadEnvFile } from "@scriptoria/config";

/**
 * The end-to-end suite — the only tests in this repository that exercise the
 * product as a person meets it: a browser, a real directory bind, a real PTY on
 * the script VM, real files coming back.
 *
 * It runs its **own** stack, on its own ports and against its own database, and
 * that is deliberate. A suite pointed at `make run` would depend on whatever
 * state the developer's session left behind, and one that wrote into the dev
 * database would destroy it; `make test-db` creates `scriptoria_e2e` for
 * exactly this. What the suite does *not* provide is the infrastructure —
 * Postgres, Redis, the directory and the sshd fixture come from `make dev`,
 * because standing up a second copy of five containers per test run would cost
 * minutes to prove nothing.
 */

loadEnvFile();

const FRONTEND_PORT = 3100;
const BACKEND_PORT = 3101;

/** The dev database's connection, pointed at the e2e database beside it. */
const DATABASE_URL =
  process.env["E2E_DATABASE_URL"] ??
  (process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/scriptoria").replace(
    /\/[^/?]+(\?|$)/,
    "/scriptoria_e2e$1",
  );

/**
 * The environment both tiers are started with. `process.env` wins over the
 * repository's `.env` (Node's own `loadEnvFile` does not overwrite what is
 * already set), so these are overrides rather than a second configuration.
 */
export const stackEnv = {
  ...process.env,
  NODE_ENV: "development",
  DATABASE_URL,
  BACKEND_PORT: String(BACKEND_PORT),
  FRONTEND_PORT: String(FRONTEND_PORT),
  BACKEND_INTERNAL_URL: `http://localhost:${BACKEND_PORT}`,
  // Read at compile time by the client bundle, so it has to be right before the
  // frontend starts rather than when a test opens the terminal.
  NEXT_PUBLIC_TERMINAL_WS_URL: `ws://localhost:${BACKEND_PORT}`,
  LOG_LEVEL: "warn",
  // See apps/frontend/next.config.mjs — the dev overlay's portal covers the
  // sign-out button, and a test cannot click through it.
  DISABLE_DEV_INDICATORS: "true",
} as Record<string, string>;

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  globalTeardown: "./support/global-teardown.ts",

  /**
   * Serial, and one worker. These tests share one script VM, one run queue and
   * one database: two of them starting scripts at once would be testing the
   * scheduler rather than the product, and the flake would be real but
   * uninteresting.
   */
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },

  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  /**
   * Both web tiers, started in development mode. Production mode would need a
   * build per run, and the thing under test is the product's behaviour rather
   * than its bundling — the images prove that (`make docker-build`).
   *
   * The runner is not here: Playwright waits for a URL, and the runner listens
   * on no port. It is started in the global setup instead.
   */
  webServer: [
    {
      command: "pnpm --filter backend dev",
      url: `http://localhost:${BACKEND_PORT}/api/health`,
      cwd: "..",
      env: stackEnv,
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter frontend dev",
      url: `http://localhost:${FRONTEND_PORT}/login`,
      cwd: "..",
      env: stackEnv,
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
