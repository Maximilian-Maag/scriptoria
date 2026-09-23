/**
 * NFR-18 — one area's people cannot reach another area's things — and FA-02.4.
 *
 * This is the tenant boundary, and it is asserted from *outside* the interface
 * for the calls the interface happens to make, and from outside the interface
 * for the calls it does not: a refusal that only exists because a button is
 * missing is not a boundary. Two accounts are signed in at once, in two
 * browsers, and the second one goes after the first one's identifiers directly.
 *
 * Every one of these must be indistinguishable from "there is nothing there",
 * because FA-02 treats the existence of another area's run history as
 * information an administrator is not entitled to. A `forbidden` and a
 * `not_found` are both refusals; an empty list or a real payload is not.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { ACCOUNTS, BASE_URL, REFERENCE_AREA, SCRIPTS } from "../src/env";
import {
  apiGet,
  areaIdFor,
  expectSucceeded,
  openArea,
  selectScript,
  signIn,
  startSelectedScript,
  waitForRun,
} from "../src/ui";

/** The three ways the control plane may refuse: anything else is a leak. */
const REFUSED = [403, 404];

test.describe("one area's people cannot reach another area's things (NFR-18, FA-02.4)", () => {
  test("an account entitled to nothing sees no areas, no runs and no scripts (FA-02.4)", async ({
    page,
    browser,
  }) => {
    await signIn(page, ACCOUNTS.none);

    // Signed in successfully, and entitled to nothing: FA-01.4's empty screen.
    expect(await apiGet<unknown[]>(page, "/areas")).toHaveLength(0);
    expect(await apiGet<{ items: unknown[]; total: number }>(page, "/runs")).toMatchObject({
      items: [],
      total: 0,
    });

    // The reference area exists and is not this account's business.
    const areaId = await discoverReferenceAreaId(browser);
    expect((await page.request.get(`/api/proxy/areas/${areaId}/scripts`)).status()).toBe(403);

    // Naming an area in a query string is not a way in either.
    const filtered = await apiGet<{ items: unknown[]; total: number }>(
      page,
      `/runs?areaId=${areaId}`,
    );
    expect(
      filtered.items,
      "an areaId the session is not entitled to must filter to nothing",
    ).toEqual([]);
  });

  test("another area's run, its terminal, its results and its files are all refused (NFR-18)", async ({
    page,
    browser,
  }) => {
    // The owner: starts a run that writes four result files.
    await signIn(page, ACCOUNTS.branch);
    await openArea(page, REFERENCE_AREA.name);
    await selectScript(page, SCRIPTS.inventory.fileName);
    const runId = await startSelectedScript(page);
    expectSucceeded(await waitForRun(page, runId));

    const areaId = await areaIdFor(page, REFERENCE_AREA.name);
    const results = await apiGet<{ files: { path: string }[] }>(page, `/runs/${runId}/results`);
    const path = results.files[0]?.path as string;

    // The outsider: signed in, entitled to other areas, holding the identifier.
    const outsider = await newSession(browser, ACCOUNTS.datacenter);

    try {
      const paths: [string, string][] = [
        ["the run itself", `/runs/${runId}`],
        ["its events", `/runs/${runId}/events`],
        ["its terminal", `/runs/${runId}/transcript`],
        ["its results", `/runs/${runId}/results`],
        ["a preview of one file", `/runs/${runId}/results/preview?path=${encodeURIComponent(path)}`],
        ["one file", `/runs/${runId}/results/file?path=${encodeURIComponent(path)}`],
        ["the area it belongs to", `/areas/${areaId}`],
        ["that area's scripts", `/areas/${areaId}/scripts`],
      ];

      for (const [what, path] of paths) {
        const refused = await outsider.request.get(`/api/proxy${path}`);
        expect(
          REFUSED,
          `${what} must be refused to an account entitled to another area (got ${refused.status()})`,
        ).toContain(refused.status());
      }

      // Aborting somebody else's run is not a way to reach it either — and it
      // must not succeed even for a run that is still going.
      const abort = await outsider.request.delete(`/api/proxy/runs/${runId}`, {
        data: { confirmScriptName: SCRIPTS.inventory.fileName },
      });
      expect(REFUSED, `aborting another area's run must be refused (got ${abort.status()})`).toContain(
        abort.status(),
      );

      // The run's own record is still there afterwards, untouched.
      expect((await waitForRun(page, runId)).status).toBe("succeeded");
    } finally {
      await outsider.close();
    }
  });

  test("the interface does not offer what the account cannot have (FA-02.4, NFR-18)", async ({
    page,
    browser,
  }) => {
    await signIn(page, ACCOUNTS.branch);
    const areaId = await areaIdFor(page, REFERENCE_AREA.name);

    const outsider = await newSession(browser, ACCOUNTS.datacenter);
    try {
      // No link to another area's things anywhere in the shell.
      await expect(outsider.getByRole("link", { name: REFERENCE_AREA.name })).toHaveCount(0);

      // A deep link is not a way to read it either. The area's *layout* renders
      // its tab strip for any id — which is why this asserts on content rather
      // than on the tabs: no script of the area, and a page that says it could
      // not read the directory.
      await outsider.goto(`/areas/${areaId}`);
      await expect(outsider.getByText("Could not read the script directory")).toBeVisible();
      await expect(outsider.getByText(SCRIPTS.inventory.fileName)).toHaveCount(0);
      await expect(outsider.getByRole("button", { name: /inventory-report\.sh/ })).toHaveCount(0);

      // FA-11's administration screen is equally absent to it.
      await expect(outsider.getByRole("link", { name: "Areas & entitlements" })).toHaveCount(0);
    } finally {
      await outsider.close();
    }
  });
});

/** The reference area's id, learned through an account entitled to it. */
async function discoverReferenceAreaId(browser: Browser): Promise<string> {
  const owner = await newSession(browser, ACCOUNTS.branch);
  try {
    const areas = await apiGet<{ id: string; name: string }[]>(owner, "/areas");
    const area = areas.find((candidate) => candidate.name === REFERENCE_AREA.name);
    if (!area) throw new Error(`${REFERENCE_AREA.name} is not visible to its own administrators`);
    return area.id;
  } finally {
    await owner.close();
  }
}

/** A second signed-in browser, so two accounts are held at the same time. */
async function newSession(browser: Browser, account: { username: string; password: string }): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  await signIn(page, account);
  return page;
}
