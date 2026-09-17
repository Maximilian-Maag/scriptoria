import { expect, test } from "@playwright/test";
import { ACCOUNTS, READ_ONLY_SCRIPT, REFERENCE_AREA } from "../support/accounts";
import { signIn } from "../support/session";

/**
 * The walking skeleton, end to end and in a browser: select, start, watch it
 * run on a real PTY, and collect what it wrote.
 *
 * This is the one test in the repository that proves the four risky assumptions
 * together — the directory bind, SSH/PTY interactivity, the live stream, and
 * SFTP result access. Everything else can pass while the product does nothing.
 */
test.describe("FA-05 … FA-09 a run, from start to results", () => {
  test("starts a script, streams its output, and offers what it wrote", async ({ page }) => {
    test.slow(); // A real SSH connection, a real PTY and a real file collection.

    await signIn(page, ACCOUNTS.administrator);
    await page.getByRole("link", { name: REFERENCE_AREA }).click();
    await page.getByText(READ_ONLY_SCRIPT).click();

    // FA-05.1 / FA-05.5 — the start takes no parameters. There is no form here
    // to fill in, and that absence is the requirement.
    await page.getByRole("button", { name: "Start this script" }).click();

    // 202 rather than 201: the run is accepted, not running. The console says
    // so honestly rather than pretending it has started.
    await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);

    // FA-07.1 — the live output, as the script produces it. The terminal is
    // xterm.js, so the assertion is on rendered text rather than on an element.
    await expect(page.getByText(/Reading interfaces for site/).first()).toBeVisible({
      timeout: 45_000,
    });

    // FA-05.4 — the run reaches a terminal state and the status line says which.
    // `exact` matters: the status line also carries a column *labelled*
    // FINISHED, and a substring match is happy with that whether or not the run
    // ever ended.
    await expect(page.getByText("Finished", { exact: true })).toBeVisible({ timeout: 45_000 });

    // FA-09.5 / FA-09.1 — what it wrote is reachable without a jump server and
    // without SFTP by hand (NFR-15), for a failed run as much as a successful
    // one.
    // Exact again: each row shows the name and, under it, the path it came from
    // — so the bare name matches twice.
    await expect(page.getByText("alpha.csv", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("button", { name: /Download all \d+ as ZIP/ })).toBeVisible();
  });

  /**
   * FA-05.4 and FA-09.5 — a finished run has to be findable again. Without this
   * the product could start a script and then lose it: the console is reachable
   * only by having just started something, so a closed tab took the run with it.
   */
  test("a finished run is findable again in the area's history", async ({ page }) => {
    await signIn(page, ACCOUNTS.administrator);
    await page.getByRole("link", { name: REFERENCE_AREA }).click();
    await page.getByRole("link", { name: "Runs", exact: true }).click();

    // The row itself is the link — clicking the file name inside it is not the
    // same thing, and matching text anywhere on the page finds the heading too.
    const row = page.getByRole("link").filter({ hasText: READ_ONLY_SCRIPT }).first();
    await expect(row).toBeVisible();
    await row.click();

    await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/Finished|Failed|Stopped/).first()).toBeVisible();
  });
});
