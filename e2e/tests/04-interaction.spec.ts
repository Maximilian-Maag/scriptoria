/**
 * FA-06 — script interaction — and the half of FA-07 that only an interactive
 * script can show.
 *
 * The fixture's `site-rollout.sh` is the script the terminal exists for: a real
 * PTY, a prompt that blocks on stdin, output that is part of the interaction
 * rather than its end (FA-06.3), and a loop over sites with no natural end
 * (FA-08.2).
 *
 * What is asserted is causal rather than cosmetic. `done: alpha` can only be in
 * the transcript if the `y` typed into the terminal reached the process, and
 * `done: bravo` can only be there if a *second* answer was given — which is
 * FA-06.2's "several dialogue steps are walked through iteratively".
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

async function transcriptOf(page: Parameters<typeof apiGet>[0], runId: string): Promise<string> {
  const transcript = await apiGet<{ contentBase64: string }>(page, `/runs/${runId}/transcript`);
  return Buffer.from(transcript.contentBase64, "base64").toString("utf8");
}

/** Types into the terminal the way an operator does — the emulator has focus. */
async function answer(page: Parameters<typeof apiGet>[0], text: string): Promise<void> {
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test.describe("interacting with a running script (FA-06)", () => {
  test("typing into the terminal drives the script, step by step (FA-06.1, FA-06.2, FA-06.3)", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.branch);
    await openArea(page, REFERENCE_AREA.name);
    await selectScript(page, SCRIPTS.rollout.fileName);
    const runId = await startSelectedScript(page);

    // NFR-08: the stream is live while the script is. The indicator is the
    // browser's own view of its socket, not a server-side claim.
    await waitForRun(page, runId, { until: ["running"] });
    await expect(page.getByText("streaming")).toBeVisible();

    // FA-06.1: the script has blocked on `read`. This answers it. The terminal
    // takes focus on a click, exactly as it does for a person.
    await page.locator(".xterm").click();
    await answer(page, "y");
    await page.waitForTimeout(2_500);

    // FA-06.2: and a second step of the same dialogue.
    await answer(page, "y");
    await page.waitForTimeout(2_500);

    // FA-08.2's other half: the loop has no natural end, so it is ended
    // explicitly — the fixture stops on `q`.
    await answer(page, "q");

    const run = await waitForRun(page, runId);
    expectSucceeded(run);

    const transcript = await transcriptOf(page, runId);
    // Only an accepted answer produces these lines, and two of them prove the
    // dialogue was walked through iteratively rather than answered once.
    expect(transcript).toContain("done: alpha");
    expect(transcript).toContain("done: bravo");
    expect(transcript).toContain("Stopping at operator request.");

    // FA-06.3: the output is part of the interaction, not its end — the prompt
    // that was answered is in the record.
    expect(transcript).toContain("Apply configuration to site alpha?");
  });

  test("a script that asks questions is shown as one before it is started (FA-03.4, FA-06.1)", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.branch);
    await openArea(page, REFERENCE_AREA.name);
    await selectScript(page, SCRIPTS.rollout.fileName);

    // Told before the start, not discovered afterwards: the fixture's header
    // declares itself interactive and the panel says so.
    await expect(page.locator("aside")).toContainText("Asks questions");
  });
});
