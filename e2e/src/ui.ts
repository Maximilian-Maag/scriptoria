/**
 * The verbs every spec needs: sign somebody in, open an area, start a script,
 * and watch a run.
 *
 * Two rules hold throughout, and both exist to keep the suite honest:
 *
 *   1. **The interface is driven, not the API.** Selecting a script, starting
 *      it and stopping it happen through clicks, because FA-04.1 makes
 *      selection and start two separate steps and only the interface can prove
 *      they are. The API is used for *reading* — polling a run's status, which
 *      the page itself polls — so a spec fails on behaviour rather than on a
 *      renderer's timing.
 *   2. **Nothing is asserted that was not observed.** Where a helper polls, it
 *      polls the same endpoint the application polls, and returns the record it
 *      actually read.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { ACCOUNTS, SCRIPTS } from "./env";

export interface Account {
  readonly username: string;
  readonly password: string;
}

/** Only what the suite reads. The contracts package is the authority. */
export interface AreaSummary {
  id: string;
  name: string;
  category: "one-off" | "recurring";
}

export interface ScriptRecord {
  id: string;
  fileName: string;
  title: string;
  criticality: "read-only" | "modifying" | "unknown";
  interactive: boolean;
  present: boolean;
  absolutePath: string;
}

export interface RunRecord {
  id: string;
  status: "queued" | "starting" | "running" | "succeeded" | "failed" | "aborted";
  exitCode: number | null;
  failureReason: string | null;
  scriptFileName: string;
  scriptTitle: string;
  criticality: "read-only" | "modifying" | "unknown";
  startedBy: string;
  host: string;
  resultCount: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  abortStage: string | null;
}

export interface ResultFileRecord {
  path: string;
  name: string;
  sizeBytes: number;
  previewable: boolean;
}

export interface ResultListRecord {
  directory: string;
  files: ResultFileRecord[];
  totalBytes: number;
  partial: boolean;
}

export const TERMINAL_STATUSES: ReadonlyArray<RunRecord["status"]> = [
  "succeeded",
  "failed",
  "aborted",
];

/**
 * The application's own `role="alert"` elements — and not Next.js's.
 *
 * The App Router renders a route announcer: an empty `<div role="alert"
 * id="__next-route-announcer__">`, clipped to a single pixel and living inside
 * a shadow root. `getByRole("alert")` matches it, it is "visible" by
 * Playwright's definition, and it is empty — so a spec that waits for an alert
 * and reads its text resolves instantly against the framework's screen-reader
 * plumbing and concludes that the application said nothing. Every assertion
 * about a refusal, a validation message or an error banner has to say which
 * alerts it means.
 */
export function appAlerts(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

// ── Signing in and out ───────────────────────────────────────────────────────

/**
 * FA-01.1. Waits for the shell rather than for a URL, because the shell is the
 * thing that says a session exists — the redirect alone would also happen for a
 * session that was refused.
 */
export async function signIn(page: Page, account: Account = ACCOUNTS.branch): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

/** Fills the form with credentials that must not be accepted, and returns the refusal. */
export async function attemptSignIn(page: Page, account: Account): Promise<string> {
  await page.goto("/login");
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const alert = appAlerts(page);
  await expect(alert).toBeVisible();
  return (await alert.textContent()) ?? "";
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

// ── Navigating the areas and the catalog (FA-03, FA-04) ──────────────────────

/** Opens an area from the left navigation — the explicit click FA-03.6 asks for. */
export async function openArea(page: Page, areaName: string): Promise<void> {
  await page.getByRole("link", { name: areaName }).click();
  await expect(page).toHaveURL(/\/areas\/[0-9a-fA-F-]{36}$/);
  await expect(page.getByRole("button", { name: /Rescan|Reading/ })).toBeVisible();
}

/** Selects a script in the list. Selection and start are two steps (FA-04.1). */
export async function selectScript(page: Page, fileName: string): Promise<void> {
  await page
    .getByRole("button", { name: new RegExp(escapeRegExp(fileName)) })
    .first()
    .click();
  // The detail panel is what selection opens. Waiting for its start button is
  // waiting for the panel itself, and it is the same wait for a script that is
  // present and for one the scan did not find.
  await expect(
    page.getByRole("button", { name: /Start this script|Not on the script VM/ }),
  ).toBeVisible();
}

/** FA-03.3, FA-04.1 — the button that starts the selected script, and the run it makes. */
export async function startSelectedScript(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Start this script" }).click();
  await page.waitForURL(/\/runs\/[0-9a-fA-F-]{36}$/);
  return runIdFromUrl(page.url());
}

export function runIdFromUrl(url: string): string {
  const match = /\/runs\/([0-9a-fA-F-]{36})/.exec(url);
  if (!match?.[1]) throw new Error(`no run id in ${url}`);
  return match[1];
}

// ── Reading through the proxy, with the page's own session ───────────────────

/**
 * The same route the interface uses (`/api/proxy/...`), so a helper cannot
 * reach anything a person could not, and the session cookie under test is the
 * one in the browser context.
 */
export async function apiGet<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api/proxy${path}`);
  if (!response.ok()) {
    throw new Error(`GET ${path} answered ${response.status()}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function apiPost<T>(page: Page, path: string, body?: unknown): Promise<T> {
  const response = await page.request.post(`/api/proxy${path}`, {
    ...(body === undefined ? {} : { data: body }),
  });
  if (!response.ok()) {
    throw new Error(`POST ${path} answered ${response.status()}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Used by specs that build and then dismantle their own fixture state. */
export async function apiDelete(page: Page, path: string): Promise<void> {
  const response = await page.request.delete(`/api/proxy${path}`);
  if (!response.ok()) {
    throw new Error(`DELETE ${path} answered ${response.status()}: ${await response.text()}`);
  }
}

export async function apiPatch<T>(page: Page, path: string, body: unknown): Promise<T> {
  const response = await page.request.patch(`/api/proxy${path}`, { data: body });
  if (!response.ok()) {
    throw new Error(`PATCH ${path} answered ${response.status()}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** A row in a list, by a fragment of its accessible name. */
export function rowContaining(page: Page, text: string): Locator {
  return page.getByRole("button", { name: new RegExp(escapeRegExp(text)) }).first();
}

export async function areasFor(page: Page): Promise<AreaSummary[]> {
  return apiGet<AreaSummary[]>(page, "/areas");
}

export async function areaIdFor(page: Page, name: string): Promise<string> {
  const areas = await areasFor(page);
  const area = areas.find((candidate) => candidate.name === name);
  if (!area) {
    throw new Error(`no area named ${name} among: ${areas.map((a) => a.name).join(", ")}`);
  }
  return area.id;
}

export async function scriptsFor(page: Page, areaId: string): Promise<ScriptRecord[]> {
  return apiGet<ScriptRecord[]>(page, `/areas/${areaId}/scripts`);
}

/** The catalog entry for a fixture script, by file name. */
export async function scriptByName(
  page: Page,
  areaId: string,
  fileName: string,
): Promise<ScriptRecord> {
  const scripts = await scriptsFor(page, areaId);
  const script = scripts.find((candidate) => candidate.fileName === fileName);
  if (!script) {
    throw new Error(
      `no script ${fileName} in area ${areaId} among: ${scripts.map((s) => s.fileName).join(", ")}`,
    );
  }
  return script;
}

export async function runRecord(page: Page, runId: string): Promise<RunRecord> {
  return apiGet<RunRecord>(page, `/runs/${runId}`);
}

export async function resultsFor(page: Page, runId: string): Promise<ResultListRecord> {
  return apiGet<ResultListRecord>(page, `/runs/${runId}/results`);
}

/**
 * Waits for a run to reach a terminal status, by polling what the status line
 * polls. Returns the record it read, so a spec asserts on observed state.
 */
export async function waitForRun(
  page: Page,
  runId: string,
  options: { until?: ReadonlyArray<RunRecord["status"]>; timeoutMs?: number } = {},
): Promise<RunRecord> {
  const until = options.until ?? TERMINAL_STATUSES;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let last: RunRecord | undefined;

  while (Date.now() < deadline) {
    last = await runRecord(page, runId);
    if (until.includes(last.status)) return last;
    await page.waitForTimeout(500);
  }

  throw new Error(
    `run ${runId} was still ${last?.status ?? "unknown"} after ` +
      `${options.timeoutMs ?? 120_000}ms (exit ${last?.exitCode ?? "—"}, ` +
      `reason ${last?.failureReason ?? "—"})`,
  );
}

/** Fails the spec with what the run actually said, rather than on a timeout. */
export function expectSucceeded(run: RunRecord): void {
  expect(
    { status: run.status, exitCode: run.exitCode, failureReason: run.failureReason },
    `run ${run.id} of ${run.scriptFileName} did not succeed`,
  ).toEqual({ status: "succeeded", exitCode: 0, failureReason: null });
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The two fixture scripts, re-exported so a spec names them, not their paths. */
export { SCRIPTS };
