import { expect, test } from "@playwright/test";
import { ACCOUNTS, MODIFYING_SCRIPT, REFERENCE_AREA } from "../support/accounts";
import { signIn } from "../support/session";

/**
 * FA-08.3 and ADR-003 — stopping a modifying script.
 *
 * The confirmation is the script's own file name rather than a yes/no box,
 * because the thing being prevented is stopping the *wrong* run out of a list,
 * and a yes/no box does not prevent that. This test is therefore mostly about
 * what the button refuses to do.
 */
test("a modifying run is stopped only by naming the script", async ({ page }) => {
  test.slow();

  await signIn(page, ACCOUNTS.administrator);
  await page.getByRole("link", { name: REFERENCE_AREA }).click();
  await page.getByText(MODIFYING_SCRIPT).click();
  await page.getByRole("button", { name: "Start this script" }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);

  await expect(page.getByText(/Running|Starting|Queued/).first()).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Stop", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The platform cannot roll anything back and says so rather than implying
  // otherwise (NFR-06). That sentence is part of the safeguard, not decoration.
  await expect(dialog.getByText(/cannot undo any of it/i)).toBeVisible();

  const confirm = dialog.getByRole("button", { name: /Stop it/ });
  await expect(confirm).toBeDisabled();

  // A near miss is still a miss.
  await dialog.getByRole("textbox").fill(MODIFYING_SCRIPT.replace(".sh", ""));
  await expect(confirm).toBeDisabled();

  await dialog.getByRole("textbox").fill(MODIFYING_SCRIPT);
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // "Stopped", not "Failed": an abort was a decision, and the interface does
  // not colour it as a failure.
  await expect(page.getByText("Stopped")).toBeVisible({ timeout: 45_000 });
});
