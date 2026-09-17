import { expect, type Page } from "@playwright/test";

/**
 * Signing in, as a person does it — through the form, not by planting a cookie.
 *
 * The session is the product's central mechanism (NFR-03: it is held
 * server-side so that entitlement can be revoked while it is live), and a suite
 * that fabricated one would be testing every screen against a session shape
 * that the login path might no longer produce.
 */
export async function signIn(
  page: Page,
  account: { username: string; password: string },
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/");
}

/** The left navigation is rendered only for a session, so it is the signal. */
export async function expectSignedIn(page: Page, username: string): Promise<void> {
  await expect(page.getByText(username, { exact: true })).toBeVisible();
}
