/**
 * FA-10 — recurring scripts — and ADR-005, which is the requirement's spine:
 * **the crontab on the script VM stays authoritative**, the platform reads and
 * writes it and runs no second scheduler.
 *
 * The fixture's crontab is built to catch the failure this ADR exists to
 * prevent. Two of its entries are hand-written and predate the platform, one of
 * them oddly spaced on purpose; a read-modify-write that reformats the file —
 * or one that writes the managed jobs a second time — drops or duplicates
 * somebody else's work, and in an estate where a dropped job means hundreds of
 * systems did not get something, that is the expensive kind of bug.
 *
 * The writing half needs an area the *root* account can reach (FA-10.4), and
 * the root account is in no area group of its own (requirements §1). This spec
 * therefore builds one — a new area, mapped onto the same script VM and
 * entitled to the root group — and removes it again afterwards, so the seeded
 * state the other specs assert on is exactly as the seed left it.
 */
import { expect, test } from "../src/test";
import { ACCOUNTS, BASE_URL, GROUPS, REFERENCE_AREA } from "../src/env";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  areaIdFor,
  expectSucceeded,
  openArea,
  signIn,
  waitForRun,
} from "../src/ui";

interface ScheduleRecord {
  id: string;
  expression: string;
  command: string;
  enabled: boolean;
  managed: boolean;
  scriptId: string | null;
  expressionDescription: string;
  lastSuccessfulAt: string | null;
  nextRunAt: string | null;
}

interface AdminArea {
  id: string;
  name: string;
  sources: { host: string; port: number; username: string; scriptPath: string; outputPath: string }[];
  entitlements: { id: string; directoryGroup: string }[];
}

/**
 * The two entries the fixture writes by hand, as the interface reads them back.
 *
 * The second is spaced oddly on purpose. The file keeps that spacing —
 * `packages/core/test/crontab.test.ts` holds the raw text byte-for-byte — but an
 * expression is *normalised* the moment it is parsed, so everything read back
 * through the API is single-spaced. Asserting on the reading is therefore the
 * most this suite can do about somebody else's lines; the bytes on the VM are
 * the core suite's business, and it does check them.
 */
const HAND_WRITTEN = [
  {
    expression: "17 3 * * *",
    command:
      "/opt/scriptoria/scripts/inventory-report.sh >> /opt/scriptoria/export/cron-inventory.log 2>&1",
  },
  {
    expression: "30 4 * * 1",
    command: "/usr/bin/find /opt/scriptoria/export -type f -mtime +30 -delete",
  },
];

/** `expression command` for every entry, which is what the platform writes back. */
const asLines = (entries: ScheduleRecord[]): string[] =>
  entries.map((entry) => `${entry.expression} ${entry.command}`);

const HAND_WRITTEN_LINES = HAND_WRITTEN.map((entry) => `${entry.expression} ${entry.command}`);

/**
 * The expression the fixture's managed block carries (`infra/sshd/crontab`), and
 * the one this spec edits it to. The first is what the fixture is restored to:
 * the crontab belongs to the script VM, and a suite run must not leave it
 * changed for the next one.
 */
const FIXTURE_EXPRESSION = "0 2 * * *";
const EDITED_EXPRESSION = "15 2 * * *";

test.describe("recurring scripts (FA-10) and the crontab that owns them (ADR-005)", () => {
  // Every interaction here is a round trip to the script VM through the runner,
  // and the writing half does several of them — create the area, read the
  // crontab, write it, read it back. Generous, but not open-ended: a round trip
  // that never returns should be reported, not waited on.
  test.setTimeout(90_000);

  test("an area's crontab is shown as it is, managed entries apart from hand-written ones (FA-10.1)", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.branch);
    await openArea(page, REFERENCE_AREA.name);
    await page.getByRole("link", { name: "Schedules", exact: true }).click();

    const areaId = await areaIdFor(page, REFERENCE_AREA.name);
    const schedules = await apiGet<ScheduleRecord[]>(page, `/schedules?areaId=${areaId}`);

    expect(schedules, "the fixture crontab holds three jobs").toHaveLength(3);
    expect(schedules.filter((entry) => entry.managed)).toHaveLength(1);

    // FA-10.1 is "which scripts run regularly" — not "which ones this platform
    // happens to manage". Both halves are on screen, and the hand-written jobs
    // are shown with the spacing they were written with.
    await expect(page.getByRole("heading", { name: "Maintained here" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Written by hand on the script VM" }),
    ).toBeVisible();
    // Both halves of FA-10.1 on screen: somebody else's jobs are shown with the
    // schedule they have, and the command they run — not hidden because this
    // platform did not write them. Scoped to the hand-written section, because
    // the managed entry can run the same script and would otherwise match too.
    const foreignSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Written by hand on the script VM" }) });
    for (const entry of HAND_WRITTEN) {
      const row = foreignSection.locator("li").filter({ hasText: entry.command }).first();
      await expect(row, `${entry.command} must be listed as it is on the VM`).toContainText(
        entry.expression,
      );
    }

    // Somebody else's jobs are read-only here: no affordance to change them.
    const foreign = page.locator("li").filter({ hasText: "cron-inventory.log" }).first();
    await expect(foreign.getByRole("button", { name: "Change" })).toHaveCount(0);
    await expect(foreign.getByRole("button", { name: "Disable" })).toHaveCount(0);
  });

  test("a recurring script runs on demand, and last successful is recorded afterwards (FA-10.2, FA-10.3)", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.branch);
    await openArea(page, REFERENCE_AREA.name);
    await page.getByRole("link", { name: "Schedules", exact: true }).click();

    // FA-10.3 — the same script, started now, to get its result immediately.
    // The hand-written entry that runs the same script has no start button (it
    // is not this platform's to start), so the managed section is the one asked.
    const managedSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Maintained here" }) });
    await managedSection.getByRole("button", { name: "Run now" }).click();
    await page.waitForURL(/\/runs\/[0-9a-fA-F-]{36}$/);
    const runId = page.url().split("/").pop() as string;
    expectSucceeded(await waitForRun(page, runId));

    // FA-10.2, reduced deliberately to *last successful* (O-1).
    const areaId = await areaIdFor(page, REFERENCE_AREA.name);
    const after = await apiGet<ScheduleRecord[]>(page, `/schedules?areaId=${areaId}`);
    const managed = after.find((entry) => entry.managed);
    expect(managed?.lastSuccessfulAt, "last successful must be a time, not empty").toBeTruthy();
  });

  test("the root account changes when a job runs (FA-10.4)", async ({ page }) => {
    await signIn(page, ACCOUNTS.root);
    const area = await createAreaForRoot(page);
    // Recorded before anything else can fail, so the cleanup hook below always
    // knows which area to take down and which crontab to put back.
    written = { areaId: area.id };

    // Warm the catalogue before the screen asks for it. A brand-new area's first
    // read is a scan of the script VM, and the schedules screen maps each
    // crontab command to a script in that area — so without this the first
    // render waits on an SSH round trip that the screen did not budget for.
    await apiGet<unknown[]>(page, `/areas/${area.id}/scripts`);

    await page.goto(`/areas/${area.id}/schedules`);
    await expect(page.getByRole("heading", { name: "Maintained here" })).toBeVisible();

    // FA-10.4: the schedule is changed through the interface, not over SSH.
    const row = managedRow(page);
    await expect(row, "the managed entry must be listed before it can be changed").toBeVisible({
      timeout: 30_000,
    });
    await row.getByRole("button", { name: "Change" }).click();
    await row.getByLabel("Cron expression").fill(EDITED_EXPRESSION);
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row).toContainText(EDITED_EXPRESSION);
  });

  test("a managed write leaves every hand-written line where it was (ADR-005)", async ({ page }) => {
    // The write above is the point of this reading; two assertions rather than
    // one test because a write that hangs should say *which* step hung.
    expect(written, "the spec that writes the schedule must have run first").toBeTruthy();

    await signIn(page, ACCOUNTS.root);
    const after = await apiGet<ScheduleRecord[]>(page, `/schedules?areaId=${written?.areaId}`);

    // Read back through the product's own view of the file: exactly one managed
    // entry, carrying the new expression…
    const managed = after.filter((entry) => entry.managed);
    expect(managed, "the write must not duplicate the managed block").toHaveLength(1);
    expect(managed[0]?.expression).toBe(EDITED_EXPRESSION);

    // …and both hand-written entries still there, unchanged.
    expect(
      asLines(after.filter((entry) => !entry.managed)).sort(),
      "both hand-written entries must survive a managed-block write, unchanged",
    ).toEqual([...HAND_WRITTEN_LINES].sort());
  });
});

/**
 * Taking the fixture back to where it started, in a hook with its own budget.
 *
 * The schedule this spec edits belongs to the developer's script VM, not to the
 * suite: leaving it changed would mean the next run starts from a crontab the
 * fixture never wrote. Doing it here rather than at the end of the test body is
 * what keeps a failure in that body from leaving the machine altered.
 */
let written: { areaId: string } | null = null;

test.afterAll(async ({ browser }) => {
  if (!written) return;

  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  try {
    await signIn(page, ACCOUNTS.root);
    const schedules = await apiGet<ScheduleRecord[]>(page, `/schedules?areaId=${written.areaId}`);
    const managed = schedules.find((entry) => entry.managed);
    if (managed && managed.expression !== FIXTURE_EXPRESSION) {
      await apiPatch<ScheduleRecord>(page, `/schedules/${managed.id}`, {
        expression: FIXTURE_EXPRESSION,
      });
    }
    await apiDelete(page, `/admin/areas/${written.areaId}`);
  } finally {
    await context.close();
  }
});

/** The managed row: the hand-written entry can run the same script. */
function managedRow(page: Parameters<typeof apiGet>[0]) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Maintained here" }) })
    .locator("li")
    .filter({ hasText: "inventory-report.sh" })
    .first();
}

/** FA-11.1, FA-11.2, FA-11.4 — an area the root account itself can reach. */
async function createAreaForRoot(page: Parameters<typeof apiGet>[0]): Promise<AdminArea> {
  const created = await apiPost<AdminArea>(page, "/admin/areas", {
    name: `E2E schedules ${Date.now()}`,
    description: "Created by the end-to-end suite to edit a schedule as root, and removed again.",
    category: "recurring",
  });

  const sourced = await apiPost<AdminArea>(page, `/admin/areas/${created.id}/sources`, {
    host: "localhost",
    port: 2222,
    username: "svc.scripts",
    scriptPath: "/opt/scriptoria/scripts",
    outputPath: "/opt/scriptoria/export",
  });
  expect(sourced.sources, "the area must have a path to read scripts from").toHaveLength(1);

  return apiPost<AdminArea>(page, `/admin/areas/${created.id}/entitlements`, {
    directoryGroup: GROUPS.root,
  });
}

