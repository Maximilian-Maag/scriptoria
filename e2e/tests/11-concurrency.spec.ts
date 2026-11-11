/**
 * O-7, ADR-013 — one run at a time per script VM, and the run that waits.
 *
 * The scripts were written for sequential manual use, so the platform gives a
 * script VM one run at a time by default: the second start is *accepted* and its
 * run shows as queued, and the control plane dispatches it when the VM is free.
 * The alternative — refusing the start — would make an operator learn a rule
 * they cannot see; a status line they can watch is the honest version.
 *
 * This is the one place the difference is visible, so it is where it is asserted:
 * a long read-only script occupies the fixture's script VM, a second script is
 * started against it, and the second one must sit in `queued` — across more than
 * one sweep interval, which is what makes this a limit rather than a slow dispatch
 * — until the first one is stopped.
 *
 * The stop goes through the interface, as every write in this suite does; the two
 * runs' statuses are read from the endpoint the status line reads, so nothing here
 * asserts a renderer's timing.
 */
import { expect, test } from "../src/test";
import { ACCOUNTS, REFERENCE_AREA, SCRIPTS } from "../src/env";
import {
  expectSucceeded,
  openArea,
  runRecord,
  selectScript,
  signIn,
  startSelectedScript,
  waitForRun,
} from "../src/ui";

test.describe("one run at a time per script VM (O-7, ADR-013)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ACCOUNTS.branch);
    await openArea(page, REFERENCE_AREA.name);
  });

  test("a second script waits for the script VM, then runs (FA-05, O-7)", async ({ page }) => {
    // The long watch holds the script VM: it loops until somebody stops it, which
    // is the only fixture state in which the limit is observable at all.
    await selectScript(page, SCRIPTS.watch.fileName);
    const watching = await startSelectedScript(page);
    await waitForRun(page, watching, { until: ["running"] });

    // Back to the area to choose the second script: the run view is where a start
    // lands, and the list lives in the area view.
    await openArea(page, REFERENCE_AREA.name);

    // FA-04.1: selection and start are two steps, so the second script is chosen
    // before it is started — and it starts while the VM is carrying the first.
    await selectScript(page, SCRIPTS.inventory.fileName);
    const waiting = await startSelectedScript(page);

    // The start is accepted: the run exists, in `queued`, with its own page.
    const queued = await runRecord(page, waiting);
    expect(queued.status).toBe("queued");
    expect(queued.startedAt, "a queued run has not been on the VM").toBeNull();

    // And it stays queued: more than one sweep interval passes with the VM busy,
    // so this is the limit holding rather than a dispatch that has not happened
    // yet. Seven seconds against a five-second sweep.
    await page.waitForTimeout(7_000);
    const stillQueued = await runRecord(page, waiting);
    expect(stillQueued.status, "the script VM is still carrying the first run").toBe("queued");

    // The status line says so, in the state machine's own words (FA-07.4).
    await expect(page.getByText("Queued", { exact: true }).first()).toBeVisible();

    // Stop the first run, through the interface: a read-only script stops without
    // a confirmation naming it (FA-08.3).
    await page.goto(`/runs/${watching}`);
    await page.getByRole("button", { name: "Stop" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("This script only reads, so it stops immediately.");
    await dialog.getByRole("button", { name: "Stop it" }).click();
    expect((await waitForRun(page, watching)).status).toBe("aborted");

    // The waiting run starts on the next sweep and runs to the end, which is the
    // point of queueing it rather than refusing it: nothing was lost, only delayed.
    const started = await waitForRun(page, waiting, { until: ["running", "succeeded"] });
    const finished = started.status === "succeeded" ? started : await waitForRun(page, waiting);

    expectSucceeded(finished);
    expect(finished.scriptFileName).toBe(SCRIPTS.inventory.fileName);
    expect(finished.startedAt, "it started on its own once the VM was free").not.toBeNull();
  });
});
