/**
 * FA-03 — the area and script overview — and FA-04, selection.
 *
 * The two requirements meet on this page and must stay apart: the overview
 * shows what a script *is* (its header, and whether it modifies anything), and
 * selection is the first of two clicks rather than the start itself.
 */
import { expect, test } from "../src/test";
import type { Browser, Page } from "@playwright/test";
import { ACCOUNTS, BASE_URL, REFERENCE_AREA, SCRIPTS } from "../src/env";
import { apiDelete, apiGet, apiPost, areaIdFor, openArea, selectScript, signIn } from "../src/ui";

/**
 * The second area FA-03.2 needs. Every area in this suite points at the same
 * script VM and the same directory (FA-11.2), because what is under test here
 * is the moving between areas rather than what each one contains.
 */
const SOURCE = {
  host: "localhost",
  port: 2222,
  username: "svc.scripts",
  scriptPath: "/opt/scriptoria/scripts",
  outputPath: "/opt/scriptoria/export",
};

/** A second browser, so root can create the area while branch is looking. */
async function newSession(
  browser: Browser,
  account: { username: string; password: string },
): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  await signIn(page, account);
  return page;
}

/** Removes the area this file created, so a re-run does not accumulate them. */
async function removeAreaByName(page: Page, name: string): Promise<void> {
  const areas = await apiGet<Array<{ id: string; name: string }>>(page, "/admin/areas");
  const leftover = areas.find((area) => area.name === name);
  if (leftover) await apiDelete(page, `/admin/areas/${leftover.id}`);
}

test.describe("the area and script overview (FA-03), and selection (FA-04)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ACCOUNTS.branch);
  });

  test("the dashboard is deliberately empty, with the areas in the left navigation (FA-03.6, NFR-13)", async ({
    page,
  }) => {
    await expect(page.getByRole("heading", { name: "Pick an area to begin" })).toBeVisible();
    await expect(page.getByRole("link", { name: REFERENCE_AREA.name })).toBeVisible();

    // FA-03.6: "Nothing else appears on the dashboard." No widgets, nothing to
    // interact with, and specifically no script list — opening an area is an
    // explicit click.
    const main = page.locator("main");
    await expect(main).not.toContainText(SCRIPTS.inventory.fileName);
    await expect(main.getByRole("button")).toHaveCount(0);
    await expect(main.getByRole("textbox")).toHaveCount(0);
  });

  test("an area lists its scripts with what each does and whether it modifies (FA-03.3, FA-03.4, FA-03.5)", async ({
    page,
  }) => {
    await openArea(page, REFERENCE_AREA.name);

    const inventory = page.getByRole("button", {
      name: new RegExp(SCRIPTS.inventory.fileName),
    });
    const rollout = page.getByRole("button", { name: new RegExp(SCRIPTS.rollout.fileName) });
    await expect(inventory).toBeVisible();
    await expect(rollout).toBeVisible();

    // FA-03.5, and the requirement the whole abort design hangs off: the
    // criticality is visible *before* anything is started, on the list itself.
    await expect(inventory).toContainText("Reads only");
    await expect(rollout).toContainText("Modifies");

    // FA-03.4: the header, so the use case is understandable before starting.
    await expect(inventory).toContainText("Reads a canned device list");
    await expect(rollout).toContainText("Walks site by site");

    // The count is stated, so an empty area is visibly empty rather than broken.
    await expect(page.getByText(/\d+ in this area/)).toBeVisible();
  });

  test("selecting a script opens its header, never its body (FA-03.4, FA-04.1)", async ({
    page,
  }) => {
    await openArea(page, REFERENCE_AREA.name);
    const areaId = await areaIdFor(page, REFERENCE_AREA.name);
    const before = await apiGet<{ total: number }>(page, `/runs?areaId=${areaId}&limit=1`);

    await selectScript(page, SCRIPTS.inventory.fileName);

    const panel = page.locator("aside");
    await expect(panel.getByRole("heading", { name: SCRIPTS.inventory.title })).toBeVisible();
    await expect(panel).toContainText("What it does");
    await expect(panel).toContainText("On the script VM");
    await expect(panel).toContainText("Writes its results to");

    // FA-03.4, the deliberate half: "The script body is deliberately not part of
    // the overview — real scripts run to thousands of lines."
    await expect(panel).not.toContainText("set -euo pipefail");
    await expect(panel).not.toContainText("#!/usr/bin/env bash");

    // FA-04.1: selection and start are two separate steps. Selecting must not
    // have started anything.
    const after = await apiGet<{ total: number }>(page, `/runs?areaId=${areaId}&limit=1`);
    expect(after.total, "selecting a script must not start a run").toBe(before.total);
    await expect(page.getByRole("button", { name: "Start this script" })).toBeVisible();
  });

  test("a script the scan did find is offered with an enabled start and no absence notice (FA-03.3)", async ({
    page,
  }) => {
    // The other half of FA-03.3: presence is a fact the catalogue states. This
    // asserts the present case, so that the "Not on the VM" path is known to be
    // conditional rather than permanent — a notice that appeared for every
    // script would pass any test of the notice itself.
    await openArea(page, REFERENCE_AREA.name);
    await selectScript(page, SCRIPTS.inventory.fileName);
    await expect(page.getByRole("button", { name: "Start this script" })).toBeEnabled();
    await expect(page.locator("aside")).not.toContainText("most recent scan did not find");
  });

  test("an administrator navigates between areas to select scripts (FA-03.2)", async ({
    page,
    browser,
  }) => {
    // The fixture seeds one area, and FA-03.2 is about the *navigation*: two
    // areas, and moving between them. The second is created the way root creates
    // one (FA-11.1–FA-11.3) and entitled to the group this account holds, so
    // that both areas are its — and taken back afterwards, which a seeded area
    // could not be.
    const second = `E2E navigation ${Date.now().toString(36)}`;
    const asRoot = await newSession(browser, ACCOUNTS.root);

    try {
      const created = await apiPost<{ id: string }>(asRoot, "/admin/areas", {
        name: second,
        description: "Created by the end-to-end suite to have a second area to move to.",
        category: "one-off",
      });
      await apiPost(asRoot, `/admin/areas/${created.id}/sources`, SOURCE);
      await apiPost(asRoot, `/admin/areas/${created.id}/entitlements`, {
        directoryGroup: REFERENCE_AREA.directoryGroup,
      });

      // The area was entitled after this session was created, and the navigation
      // is rendered from the entitlements re-resolved per request (NFR-03) — so
      // the page is reloaded, which is what an administrator arriving later
      // does. Both areas are now the account's.
      await page.reload();
      await expect(page.getByRole("link", { name: REFERENCE_AREA.name })).toBeVisible();
      await expect(page.getByRole("link", { name: second })).toBeVisible();

      // Across to the second area…
      await openArea(page, second);
      await expect(page).toHaveURL(new RegExp(`/areas/${created.id}$`));
      await expect(page.getByText(SCRIPTS.inventory.fileName)).toBeVisible();

      // …and back to the first, which is the "between" in FA-03.2. The area the
      // page is showing changed with the click, not with a sign-in.
      await openArea(page, REFERENCE_AREA.name);
      await expect(page).toHaveURL(
        new RegExp(`/areas/${await areaIdFor(page, REFERENCE_AREA.name)}$`),
      );
      await expect(page.getByText(SCRIPTS.inventory.fileName)).toBeVisible();
    } finally {
      await removeAreaByName(asRoot, second);
      await asRoot.close();
    }
  });

  test("an area holds scripts, its runs and its schedules as separate views (FA-03.3)", async ({
    page,
  }) => {
    await openArea(page, REFERENCE_AREA.name);

    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await expect(page).toHaveURL(/\/areas\/[0-9a-fA-F-]{36}\/runs$/);
    await expect(page.getByText(/\d+ runs?$/)).toBeVisible();

    await page.getByRole("link", { name: "Schedules", exact: true }).click();
    await expect(page).toHaveURL(/\/areas\/[0-9a-fA-F-]{36}\/schedules$/);
    await expect(page.getByText(/in the crontab on this area's script VM/)).toBeVisible();
  });
});
