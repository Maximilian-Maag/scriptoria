/**
 * FA-08 — stopping a script — and ADR-003's staged abort, at the one moment it
 * is visible to a person.
 *
 * The rule is FA-08.3, word for word: "a read-only script aborts immediately; a
 * **modifying** script requires confirmation and produces an audit entry." The
 * confirmation names the script, because the thing being prevented is stopping
 * the *wrong* run out of a list — and a yes/no box does not prevent that.
 */
import { expect, test } from "../src/test";
import { ACCOUNTS, REFERENCE_AREA, SCRIPTS } from "../src/env";
import {
  openArea,
  runRecord,
  selectScript,
  signIn,
  startSelectedScript,
  waitForRun,
} from "../src/ui";

test.describe("stopping a running script (FA-08, ADR-003)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ACCOUNTS.branch);
    await openArea(page, REFERENCE_AREA.name);
  });

  test("a read-only script stops on request, with no confirmation (FA-08.3)", async ({ page }) => {
    await selectScript(page, SCRIPTS.watch.fileName);
    const runId = await startSelectedScript(page);
    await waitForRun(page, runId, { until: ["running"] });

    await page.getByRole("button", { name: "Stop" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("This script only reads, so it stops immediately.");
    // No name to type, because there is nothing to be careful about.
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Stop it" }).click();

    const run = await waitForRun(page, runId);
    expect(run.status, "a read-only script stops immediately").toBe("aborted");
    expect(run.failureReason).toBe("aborted_by_user");

    // The status line calls it what it is: a decision, not a failure.
    // The wording is the state machine's own (FA-07.4): `aborted` is styled as a
    // decision, not a failure — somebody stopped it on purpose. The exit code
    // is whatever the script made of the signal, so it is not asserted here;
    // when there is none, the reason is spelled out instead.
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    const exit = page.locator("header dl > div").filter({ hasText: "Exit" });
    await expect(exit).toContainText(/stopped on request|130/);
  });

  test("a modifying script is stopped only by naming it, and a wrong name does not arm the button (FA-08.3, ADR-003)", async ({
    page,
  }) => {
    await selectScript(page, SCRIPTS.rollout.fileName);
    const runId = await startSelectedScript(page);
    await waitForRun(page, runId, { until: ["running"] });

    await page.getByRole("button", { name: "Stop" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("This script changes target systems.");
    // FA-08.3's honesty about what stopping does not do (NFR-06).
    await expect(dialog).toContainText("the platform cannot undo any of it");

    const confirm = dialog.getByRole("textbox");
    const stop = dialog.getByRole("button", { name: "Stop it" });
    await expect(confirm).toBeVisible();

    // Nothing typed: not a confirmation.
    await expect(stop).toBeDisabled();
    // The wrong script named: still not a confirmation. This is the case the
    // requirement exists for — stopping the wrong run out of a list.
    await confirm.fill(SCRIPTS.inventory.fileName);
    await expect(stop).toBeDisabled();
    // The script's own name: armed.
    await confirm.fill(SCRIPTS.rollout.fileName);
    await expect(stop).toBeEnabled();
    await stop.click();

    const run = await waitForRun(page, runId);
    expect(run.status).toBe("aborted");
    expect(run.failureReason).toBe("aborted_by_user");
  });

  test("letting it run cancels the stop and the script carries on (FA-08.1)", async ({ page }) => {
    await selectScript(page, SCRIPTS.watch.fileName);
    const runId = await startSelectedScript(page);
    await waitForRun(page, runId, { until: ["running"] });

    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Let it run" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The run was not touched by opening and dismissing the dialogue.
    const still = await runRecord(page, runId);
    expect(["starting", "running"], "the run must still be going").toContain(still.status);

    // And it is left stopped for the next spec rather than holding a PTY open.
    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Stop it" }).click();
    await waitForRun(page, runId);
  });
});
