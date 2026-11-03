/**
 * FA-09 — result provisioning.
 *
 * The requirement names three forms and is explicit that download is only one
 * of them: **display**, **copy**, **download** — plus the ZIP, which is not a
 * convenience but the normal case (a single run can produce hundreds of files
 * across dozens of sites).
 *
 * A "result" is a file in a defined directory; the **terminal** is a different
 * channel with a different lifecycle (FA-07). Nothing here asserts anything
 * about the terminal, and nothing in the terminal spec asserts anything about
 * these files.
 */
import { readFile } from "node:fs/promises";
import { expect, test } from "../src/test";
import { ACCOUNTS, REFERENCE_AREA, SCRIPTS } from "../src/env";
import {
  openArea,
  selectScript,
  signIn,
  startSelectedScript,
  waitForRun,
  expectSucceeded,
} from "../src/ui";

test.describe("the results of a run (FA-09)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ACCOUNTS.branch);
    await openArea(page, REFERENCE_AREA.name);
  });

  test("a finished run's files are listed, readable in place, copyable and downloadable (FA-09.1, FA-09.2, FA-09.4)", async ({
    page,
  }) => {
    await selectScript(page, SCRIPTS.inventory.fileName);
    const runId = await startSelectedScript(page);
    expectSucceeded(await waitForRun(page, runId));

    const panel = page.locator("aside");
    await expect(panel.getByRole("heading", { name: "Results" })).toBeVisible();

    // FA-09.1: the overview of results, and where they were written.
    for (const site of ["alpha", "bravo", "charlie", "delta"]) {
      // The name, matched exactly: the path line beneath it contains it too.
      await expect(panel.getByText(`${site}.csv`, { exact: true })).toBeVisible();
    }
    await expect(panel).toContainText("/opt/scriptoria/export");

    // ── FA-09.1 / FA-09.4: display, then copy ────────────────────────────────
    const alpha = panel.locator("li").filter({ hasText: "alpha.csv" });
    await alpha.getByRole("button", { name: "Open" }).click();

    const preview = page.getByRole("dialog");
    await expect(preview).toContainText("device,interface,status");
    await expect(preview).toContainText("sw-alpha-01");

    await preview.getByRole("button", { name: "Copy" }).click();
    await expect(preview.getByRole("button", { name: "Copied" })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied, "the clipboard carries the file's content").toContain("sw-alpha-01");

    await preview.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // ── FA-09.2: a single download ───────────────────────────────────────────
    const single = await Promise.all([
      page.waitForEvent("download"),
      alpha.getByRole("link", { name: "Download" }).click(),
    ]).then(([download]) => download);

    expect(single.suggestedFilename()).toBe("alpha.csv");
    const singlePath = await single.path();
    expect(singlePath, "the download must reach the disk").not.toBeNull();
    const saved = await readFile(singlePath as string);
    expect(saved.toString("utf8")).toContain("device,interface,status");
    expect(saved.toString("utf8")).toContain("sw-alpha-01");

    // ── FA-09.3: the whole set as one ZIP ────────────────────────────────────
    const archive = await Promise.all([
      page.waitForEvent("download"),
      panel.getByRole("button", { name: /Download all \d+ as ZIP/ }).click(),
    ]).then(([download]) => download);

    expect(archive.suggestedFilename()).toMatch(/^inventory-report-.*\.zip$/);
    const archivePath = await archive.path();
    expect(archivePath).not.toBeNull();
    const bytes = await readFile(archivePath as string);
    // A real archive, not an error envelope with a .zip name on it.
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(bytes.length).toBeGreaterThan(100);
  });

  test("the result of a run that was stopped is still shown (FA-09.5)", async ({ page }) => {
    await selectScript(page, SCRIPTS.rollout.fileName);
    const runId = await startSelectedScript(page);
    await waitForRun(page, runId, { until: ["running"] });

    // Answer the first site so the script has written something, then stop it.
    await page.locator(".xterm").click();
    await page.keyboard.type("y");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2_500);

    await page.getByRole("button", { name: "Stop" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill(SCRIPTS.rollout.fileName);
    await dialog.getByRole("button", { name: "Stop it" }).click();

    const run = await waitForRun(page, runId);
    expect(run.status).toBe("aborted");

    // FA-09.5: "the exit code ends the run but does not decide result
    // visibility." A partial result is evidence about what the run managed to
    // do before it stopped.
    const panel = page.locator("aside");
    await expect(panel.getByText("rollout.log", { exact: true })).toBeVisible({ timeout: 20_000 });
    await panel.locator("li").filter({ hasText: "rollout.log" }).getByRole("button", { name: "Open" }).click();

    const preview = page.getByRole("dialog");
    await expect(preview).toContainText("applied alpha");
  });
});
