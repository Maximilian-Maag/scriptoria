import { expect, test } from "@playwright/test";
import { ACCOUNTS, MODIFYING_SCRIPT, READ_ONLY_SCRIPT, REFERENCE_AREA } from "../support/accounts";
import { signIn } from "../support/session";

/**
 * FA-03 and FA-04 — what an administrator can tell about a script before
 * starting it, and the fact that starting it is a second, separate act.
 */
test.describe("FA-03 catalog", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ACCOUNTS.administrator);
    await page.getByRole("link", { name: REFERENCE_AREA }).click();
  });

  test("the area lists its scripts with the criticality visible on each", async ({ page }) => {
    await expect(page.getByText(READ_ONLY_SCRIPT)).toBeVisible();
    await expect(page.getByText(MODIFYING_SCRIPT)).toBeVisible();

    // FA-03.5. The badge is the requirement the whole abort design hangs off:
    // the risk has to be legible *before* the start, not after.
    await expect(page.getByText("Reads only").first()).toBeVisible();
    await expect(page.getByText("Modifies").first()).toBeVisible();
  });

  /**
   * FA-04.1 — selection and start are two steps. Clicking a script opens it;
   * it does not run it. The assertion that matters here is the negative one.
   */
  test("selecting a script opens its header and does not start it", async ({ page }) => {
    await page.getByText(READ_ONLY_SCRIPT).click();

    await expect(page.getByRole("button", { name: /^Start/ })).toBeVisible();
    // FA-03.4: the header, never the body.
    await expect(page).toHaveURL(/\/areas\//);
    await expect(page.getByText("Queued")).toHaveCount(0);
  });
});
