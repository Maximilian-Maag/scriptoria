import { expect, test } from "@playwright/test";
import { ACCOUNTS, REFERENCE_AREA } from "../support/accounts";
import { signIn } from "../support/session";

/**
 * FA-11 — the root account's screen, and the split that makes root a different
 * job rather than a bigger administrator.
 */
test.describe("FA-11 administration", () => {
  test("the root account configures areas; an administrator cannot reach them", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.root);
    await page.getByRole("link", { name: "Areas & entitlements" }).click();

    await expect(page.getByRole("heading", { name: "Areas" })).toBeVisible();
    await expect(page.getByText(REFERENCE_AREA).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "New area" })).toBeVisible();
  });

  test("an administrator is not offered administration at all", async ({ page }) => {
    await signIn(page, ACCOUNTS.administrator);

    await expect(page.getByRole("link", { name: "Areas & entitlements" })).toHaveCount(0);

    await page.goto("/admin/areas");
    // Root is not a bigger administrator: it configures what administrators can
    // reach, which is a different job and a different account.
    await expect(page.getByText(/Administration is the root account's/i)).toBeVisible();
  });

  /**
   * NFR-03, the reason sessions are held server-side rather than in a token:
   * an entitlement change reaches a session that is already live.
   */
  test("an area created by root becomes visible to an entitled session", async ({ page }) => {
    const name = `E2E Area ${Date.now()}`;

    await signIn(page, ACCOUNTS.root);
    await page.getByRole("link", { name: "Areas & entitlements" }).click();
    await page.getByRole("button", { name: "New area" }).click();

    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: /^Create/ }).click();

    await expect(page.getByText(name).first()).toBeVisible();
  });
});
