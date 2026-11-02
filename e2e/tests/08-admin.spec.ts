/**
 * FA-11 — areas and entitlements — through the screen that writes them.
 *
 * This is the only place in Scriptoria where the platform stops being
 * functionless: an area is a directory of scripts on a script VM plus the
 * directory groups entitled to it (FA-11.2, FA-11.3), and until both halves
 * exist every administrator signs in successfully and sees nothing. The screen
 * is laid out in that order — the area, then the paths its scripts come from,
 * then the groups that may reach them — so the spec follows the screen.
 *
 * Two accounts are needed to see the point of it. Root writes; an area
 * administrator then either does or does not find the area in their own
 * navigation, depending on nothing but the entitlement. That half is NFR-03 and
 * NFR-18, and it is asserted from the other account's browser rather than from
 * the root account's screen.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { ACCOUNTS, BASE_URL, GROUPS, SCRIPTS } from "../src/env";
import {
  apiDelete,
  apiGet,
  apiPost,
  expectSucceeded,
  openArea,
  rowContaining,
  selectScript,
  signIn,
  startSelectedScript,
  waitForRun,
} from "../src/ui";

interface AdminArea {
  id: string;
  name: string;
  category: string;
  sources: { id: string; host: string; port: number; username: string }[];
  entitlements: { id: string; directoryGroup: string }[];
}

interface Account {
  username: string;
  password: string;
}

/** Unique per run, so a re-run never trips over the last one's leftovers. */
const areaName = (label: string): string => `E2E ${label} ${Date.now().toString(36)}`;

/**
 * The one area the suite cannot clean up after: anything that has been run in
 * cannot be deleted at all, which is the rule this spec tests. Fixed and reused
 * so a suite re-run does not add another one every time.
 */
const HISTORY_AREA = "E2E run history";

const SOURCE = {
  host: "localhost",
  port: 2222,
  username: "svc.scripts",
  scriptPath: "/opt/scriptoria/scripts",
  outputPath: "/opt/scriptoria/export",
};

test.describe("areas and entitlements (FA-11)", () => {
  // These specs create areas, map paths, entitle groups, run scripts and
  // dismantle all of it again — well past the default budget for a screen whose
  // work is mostly waiting on the control plane.
  test.setTimeout(120_000);

  test("the root account creates an area, maps a path and entitles a group (FA-11.1–FA-11.5)", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.root);
    const name = areaName("admin");

    try {
      await page.getByRole("link", { name: "Areas & entitlements" }).click();
      await expect(page.getByRole("heading", { name: "Areas" })).toBeVisible();

      // ── FA-11.1 / FA-11.5: the area itself, and the category that files it ─
      await page.getByRole("button", { name: "New area" }).click();
      const create = page.locator("aside");
      await create.getByLabel("Name").fill(name);
      await create.getByLabel("Description").fill("Created by the end-to-end suite.");
      await create.getByRole("button", { name: "Recurring scripts" }).click();
      await create.getByRole("button", { name: "Create area" }).click();

      // A new area is a half-state, and the list says so: no paths, no groups.
      await expect(page.getByText("0 paths · 0 groups").first()).toBeVisible();

      // ── FA-11.2: the path its scripts are read from ────────────────────────
      const detail = detailPanel(page, name);
      await detail.getByRole("button", { name: "Map a path" }).click();
      await detail.getByLabel("Script VM host").fill(SOURCE.host);
      await detail.getByLabel("Port").fill(String(SOURCE.port));
      await detail.getByLabel("Runs as").fill(SOURCE.username);
      await detail.getByLabel("Script directory").fill(SOURCE.scriptPath);
      await detail.getByLabel("Output directory").fill(SOURCE.outputPath);
      await detail.getByRole("button", { name: "Map this path" }).click();

      await expect(detail).toContainText(`${SOURCE.username}@${SOURCE.host}:${SOURCE.port}`);
      await expect(detail).toContainText(`results → ${SOURCE.outputPath}`);
      await expect(page.getByText("1 path · 0 groups")).toBeVisible();

      // ── FA-11.3 / FA-11.4: the group that may reach it ─────────────────────
      await detail.getByLabel("Directory group").fill(GROUPS.datacenter);
      await detail.getByRole("button", { name: "Entitle this group" }).click();

      await expect(detail.getByRole("listitem").filter({ hasText: GROUPS.datacenter })).toBeVisible();
      await expect(page.getByText("1 path · 1 group").first()).toBeVisible();

      // ── the screen that wrote all of this is the one that takes it back ────
      await detail.getByRole("button", { name: "Delete this area" }).click();
      await expect(detail).toContainText("cannot be deleted at all");
      await detail.getByRole("button", { name: "Delete this area" }).click();

      await expect(page.getByRole("button", { name: new RegExp(name) })).toHaveCount(0);
    } finally {
      await removeAreaByName(page, name);
    }
  });

  test("the entitlement is what makes an area visible, and revoking it takes effect without a new login (FA-02.4, NFR-03, NFR-18)", async ({
    page,
    browser,
  }) => {
    await signIn(page, ACCOUNTS.root);
    const name = areaName("entitlement");
    const area = await createArea(page, name, GROUPS.datacenter);

    const other = await newSession(browser, ACCOUNTS.datacenter);

    try {
      // The group's administrator finds the area — and its scripts, because the
      // area's path is mapped (FA-11.2 and FA-11.3 together).
      await openArea(other, name);
      await expect(other.getByText(SCRIPTS.inventory.fileName)).toBeVisible();

      // Root revokes the entitlement, on the screen (FA-11.4).
      await page.goto("/admin/areas");
      await rowContaining(page, name).click();
      await detailPanel(page, name).getByRole("button", { name: "Revoke" }).click();
      await expect(page.getByText("1 path · 0 groups")).toBeVisible();

      // NFR-03: the entitlement *is* the authorisation, re-resolved at every
      // request — so the other session loses the area without signing in again,
      // and nothing was copied into its session to go stale.
      await other.reload();
      await expect(other.getByRole("link", { name: new RegExp(name) })).toHaveCount(0);

      const refused = await other.request.get(`/api/proxy/areas/${area.id}/scripts`);
      expect(
        [403, 404],
        "an area no group is entitled to must not be readable at all",
      ).toContain(refused.status());
    } finally {
      await other.close();
      await removeAreaByName(page, name);
    }
  });

  test("administration is the root account's, and the control plane refuses it independently of the screen (FA-11, requirements §1)", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.branch);

    // The navigation is honest about whose screen this is.
    await expect(page.getByRole("link", { name: "Areas & entitlements" })).toHaveCount(0);

    await page.goto("/admin/areas");
    await expect(page.getByText("Administration is the root account's")).toBeVisible();
    await expect(page.getByRole("button", { name: "New area" })).toHaveCount(0);

    // Root is not a bigger administrator (requirements §1), and the check is
    // not the screen's: the control plane refuses the same call on its own.
    const refused = await page.request.get("/api/proxy/admin/areas");
    expect(refused.status()).toBe(403);
  });

  test("an area anything has been run in cannot be deleted — the run history outranks tidying up", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.root);

    // Deliberately a fixed name, and reused once it exists: the rule under test
    // is that this area can *never* be deleted, so a suite that made a new one
    // per run would leave the fixture growing one undeletable area at a time.
    //
    // An area *with history* is what this needs, and a leftover from an earlier
    // failure is not that: if the name is there but nothing has run in it, it is
    // removed and made again — entitled to the root group, because root is the
    // account that has to be able to reach it and start the run from its screen.
    const areas = await apiGet<AdminArea[]>(page, "/admin/areas");
    const leftover = areas.find((candidate) => candidate.name === HISTORY_AREA);

    let area: AdminArea | undefined;
    if (leftover) {
      const history = await apiGet<{ total: number }>(page, `/runs?areaId=${leftover.id}`);
      if (history.total > 0) area = leftover;
      else await apiDelete(page, `/admin/areas/${leftover.id}`);
    }

    if (!area) {
      area = await createArea(page, HISTORY_AREA, GROUPS.root);
      // The shell's navigation was fetched when this session signed in, before
      // the area existed, and it does not poll — so it is re-read by returning
      // to the dashboard rather than by waiting for a link that cannot appear.
      await page.goto("/");
      await openArea(page, area.name);
      await selectScript(page, SCRIPTS.inventory.fileName);
      expectSucceeded(await waitForRun(page, await startSelectedScript(page)));
    }

    // The control plane refuses it — and this is the same call the screen's
    // Delete button makes, so the refusal the operator sees is this one.
    const refused = await page.request.delete(`/api/proxy/admin/areas/${area.id}`);
    expect(
      refused.ok(),
      `an area anything has been run in must not be deletable (got ${refused.status()})`,
    ).toBe(false);

    // And it is still there, with its history intact.
    const after = await apiGet<AdminArea[]>(page, "/admin/areas");
    expect(after.some((candidate) => candidate.id === area.id)).toBe(true);
  });
});

/**
 * The right-hand panel for one area, by its heading — the create panel and the
 * detail panel are both `aside`s, and only one of them is ever the answer.
 */
function detailPanel(page: Page, name: string) {
  return page.locator("aside").filter({ has: page.getByRole("heading", { name }) });
}

/** Creates an area with a path mapped and a group entitled, through the API. */
async function createArea(page: Page, name: string, directoryGroup: string): Promise<AdminArea> {
  const created = await apiPost<AdminArea>(page, "/admin/areas", {
    name,
    description: "Created by the end-to-end suite and removed again.",
    category: "one-off",
  });
  await apiPost<AdminArea>(page, `/admin/areas/${created.id}/sources`, SOURCE);
  return apiPost<AdminArea>(page, `/admin/areas/${created.id}/entitlements`, { directoryGroup });
}

/** Removes an area the suite created, by name, however far the test got. */
async function removeAreaByName(page: Page, name: string): Promise<void> {
  const areas = await apiGet<AdminArea[]>(page, "/admin/areas");
  const leftover = areas.find((area) => area.name === name);
  if (leftover) await apiDelete(page, `/admin/areas/${leftover.id}`);
}

/**
 * A second signed-in browser, so two accounts holding different entitlements
 * can be looked at at the same time — which is the only way to see a revocation
 * land in somebody else's session.
 */
async function newSession(browser: Browser, account: Account): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  await signIn(page, account);
  return page;
}
