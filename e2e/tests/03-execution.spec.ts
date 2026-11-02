/**
 * FA-05 — starting a script — and FA-07, the terminal.
 *
 * The fixture's `inventory-report.sh` is the non-interactive case the
 * requirements are emphatic about: nobody answers anything, and the run must
 * still be recorded in full — as a run, as a terminal history and as a result
 * set (FA-05.4, NFR-22).
 */
import { expect, test } from "../src/test";
import { ACCOUNTS, REFERENCE_AREA, SCRIPTS } from "../src/env";
import {
  apiGet,
  openArea,
  selectScript,
  signIn,
  startSelectedScript,
  waitForRun,
  expectSucceeded,
} from "../src/ui";

/** The durable copy of the terminal, decoded the way the interface decodes it. */
export async function transcriptOf(page: Parameters<typeof apiGet>[0], runId: string) {
  const transcript = await apiGet<{ contentBase64: string }>(page, `/runs/${runId}/transcript`);
  return Buffer.from(transcript.contentBase64, "base64").toString("utf8");
}

test.describe("running a script (FA-05) and its terminal (FA-07)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ACCOUNTS.branch);
    await openArea(page, REFERENCE_AREA.name);
  });

  test("a non-interactive script runs to the end and is recorded in full (FA-05.1, FA-05.2, FA-05.4, NFR-22)", async ({
    page,
  }) => {
    await selectScript(page, SCRIPTS.inventory.fileName);

    // FA-05.2: the parameter set is in the script, so nothing is asked for
    // before the start. The panel offers the start and no fields — a form here
    // would mean an operator had to know the script's parameters to run it,
    // which is the prior knowledge the requirement removes. What a *script*
    // declares is requested through dialogue after the start (FA-06), and that
    // is where the interactive script in 04-interaction is asked about its sites.
    await expect(page.locator("aside").getByRole("textbox")).toHaveCount(0);

    // FA-05.1: the start runs the selected script in its correct environment —
    // the area's own directory on the script VM, as the account its mapping
    // names, rather than anything the browser chose.
    const runId = await startSelectedScript(page);

    // FA-07.4: the status line above the terminal says where the run is, what
    // it is and who started it (FA-12.1's "who").
    const status = page.locator("header").first();
    await expect(status).toContainText(SCRIPTS.inventory.title);
    await expect(status).toContainText(SCRIPTS.inventory.fileName);
    await expect(status).toContainText(`started by ${ACCOUNTS.branch.username}`);

    const run = await waitForRun(page, runId);
    expectSucceeded(run);

    // The interface follows the run to its end: the status line stops saying it
    // is running and shows the exit code and the result count.
    await expect(status).toContainText("Finished");
    const exit = page.locator("header dl > div").filter({ hasText: "Exit" });
    await expect(exit).toContainText("0");

    // The terminal is really an emulator, not a <pre> (FA-07.1, FA-07.3).
    await expect(page.locator(".xterm")).toBeVisible();

    // NFR-22: recorded in full. The whole run is in the durable transcript,
    // including what the script printed at its start and its closing line.
    const transcript = await transcriptOf(page, runId);
    expect(transcript).toContain("Reading interfaces for site: alpha");
    expect(transcript).toContain("Reading interfaces for site: delta");
    // The tail of the run's own output, read from the durable copy. The count
    // in it is what this run wrote *plus* whatever earlier runs left in the same
    // day's directory, so it is matched rather than asserted at four.
    expect(transcript).toMatch(/Wrote \d+ files to \/opt\/scriptoria\/export/);
  });

  test("a finished run is read back from its durable transcript, not the live stream (FA-07.2)", async ({
    page,
  }) => {
    await selectScript(page, SCRIPTS.inventory.fileName);
    const runId = await startSelectedScript(page);
    await waitForRun(page, runId);

    // Away from the console, and back into the same run — without having just
    // started anything, which is the only way the console used to be reachable.
    // The run console has no area tabs, so this is the same path an operator
    // takes: back to the area, then into its history.
    await page.getByRole("link", { name: REFERENCE_AREA.name }).click();
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await expect(page.getByText("Finished").first()).toBeVisible();

    const readBack = page.waitForResponse(
      (response) =>
        response.url().includes(`/runs/${runId}/transcript`) && response.status() === 200,
      { timeout: 30_000 },
    );
    await page
      .getByRole("link", { name: new RegExp(SCRIPTS.inventory.fileName) })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));

    // FA-07.2: the whole history is there, and it comes from the durable copy —
    // the live stream is capped and expires.
    await readBack;
    await expect(page.locator(".xterm")).toBeVisible();
    const transcript = await transcriptOf(page, runId);
    expect(transcript).toContain("Reading interfaces for site: alpha");
    // The tail of the run's own output, read from the durable copy. The count
    // in it is what this run wrote *plus* whatever earlier runs left in the same
    // day's directory, so it is matched rather than asserted at four.
    expect(transcript).toMatch(/Wrote \d+ files to \/opt\/scriptoria\/export/);
  });
});
