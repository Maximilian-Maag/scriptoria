import { expect, test } from "@playwright/test";
import { ACCOUNTS, REFERENCE_AREA } from "../support/accounts";
import { expectSignedIn, signIn } from "../support/session";

/**
 * FA-01. The three outcomes of a login attempt, and they are three rather than
 * two: succeeded, failed, and succeeded-with-nothing-to-see.
 */
test.describe("FA-01 login", () => {
  test("an administrator signs in and is shown the areas their groups reach", async ({ page }) => {
    await signIn(page, ACCOUNTS.administrator);

    await expectSignedIn(page, ACCOUNTS.administrator.username);
    await expect(page.getByRole("link", { name: REFERENCE_AREA })).toBeVisible();

    // FA-03.6 — the landing page is deliberately empty. Opening an area is an
    // explicit click, and a dashboard that guessed would be wrong most of the
    // time. This asserts the absence on purpose.
    await expect(page.getByRole("heading", { name: /run|result|recent/i })).toHaveCount(0);
  });

  test("a wrong password is refused, and the reason is readable", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username").fill(ACCOUNTS.administrator.username);
    await page.getByLabel("Password").fill("not the password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  /**
   * FA-01.4, and the requirement most likely to be broken by a well-meaning
   * change: an account in no entitled group authenticates *successfully* and
   * sees nothing. The empty screen is the expected outcome and must not be
   * rendered as an error — so this test asserts both halves.
   */
  test("an account in no entitled group signs in and is told so plainly", async ({ page }) => {
    await signIn(page, ACCOUNTS.none);

    await expectSignedIn(page, ACCOUNTS.none.username);
    await expect(page.getByText("No areas yet")).toBeVisible();
    await expect(page.getByText(/ask whoever maintains the group mapping/i)).toBeVisible();

    // Not an error state: nothing to retry, nobody to escalate to. Filtered to
    // alerts that actually say something, because Next's development overlay
    // mounts an empty one of its own that is no part of the product.
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /try again|retry/i })).toHaveCount(0);
  });

  test("signing out returns to the login form and the session is gone", async ({ page }) => {
    await signIn(page, ACCOUNTS.administrator);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/login");

    // Going back to a signed-in page must not show it.
    await page.goto("/");
    await page.waitForURL("**/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});
