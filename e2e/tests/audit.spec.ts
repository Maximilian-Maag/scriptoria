import { expect, test } from "@playwright/test";
import { ACCOUNTS } from "../support/accounts";
import { signIn } from "../support/session";

/**
 * FA-12 — the recorded history, and who may read it.
 *
 * An audit trail nobody can read is a compliance artefact rather than a control
 * (NFR-05), so the screen matters as much as the table behind it.
 */
test.describe("FA-12 audit", () => {
  test("the root account reads the log and can narrow it", async ({ page }) => {
    await signIn(page, ACCOUNTS.root);
    await page.getByRole("link", { name: "Audit log" }).click();

    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();

    // This very session is in it: signing in is an audited act.
    await expect(page.getByText("Signed in").first()).toBeVisible();
    await expect(page.getByText(ACCOUNTS.root.username).first()).toBeVisible();

    // Narrowing by account is the first question anybody asks of a log.
    await page.getByLabel("Account").fill(ACCOUNTS.root.username);
    await expect(page.getByText("Clear filters")).toBeVisible();
    await expect(page.getByText(ACCOUNTS.administrator.username)).toHaveCount(0);

    // A filter matching nothing says so, rather than looking like a failure.
    await page.getByLabel("Account").fill("nobody.at.all");
    await expect(page.getByText("Nothing matches those filters")).toBeVisible();
  });

  /**
   * The roles table gives an administrator the areas, scripts, runs and results
   * their groups reach (FA-02.4) and nothing beyond it. The log is root's.
   */
  test("an administrator is not offered the log, and is refused it directly", async ({ page }) => {
    await signIn(page, ACCOUNTS.administrator);
    await expect(page.getByRole("link", { name: "Audit log" })).toHaveCount(0);

    await page.goto("/admin/audit");
    await expect(page.getByText(/the root account's/i)).toBeVisible();
    await expect(page.getByText("Signed in")).toHaveCount(0);
  });
});
