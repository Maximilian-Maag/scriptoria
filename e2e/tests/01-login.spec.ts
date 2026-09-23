/**
 * FA-01 — Login, and FA-01.4 in particular.
 *
 * "Any directory account may authenticate successfully. An account without a
 * matching group sees nothing. An empty screen is a valid, expected outcome —
 * not an error state, and must not be rendered as one."
 *
 * That last sentence is the reason the `admin.none` account exists in the
 * fixture, and the reason this file asserts on the *absence* of an error as
 * carefully as on the presence of content.
 */
import { expect, test } from "../src/test";
import { ACCOUNTS, GROUPS, REFERENCE_AREA } from "../src/env";
import { appAlerts, apiGet, areasFor, attemptSignIn, signIn, signOut } from "../src/ui";

test.describe("signing in with a directory account (FA-01)", () => {
  test("an entitled administrator signs in and lands on the empty dashboard (FA-01.1, FA-03.6)", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.branch);

    // FA-03.6: the landing page is deliberately empty, and opening an area is
    // an explicit click. Nothing else appears on the dashboard.
    await expect(page.getByRole("heading", { name: "Pick an area to begin" })).toBeVisible();
    await expect(page.getByRole("link", { name: REFERENCE_AREA.name })).toBeVisible();

    // The account is shown, and it is an administrator rather than root: root
    // is not a bigger administrator (requirements §1).
    await expect(page.getByText(ACCOUNTS.branch.username)).toBeVisible();
    await expect(page.getByText("Administrator", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Areas & entitlements/ })).toHaveCount(0);
  });

  test("a wrong password is refused and no session is created (FA-01.2)", async ({ page }) => {
    const message = await attemptSignIn(page, {
      username: ACCOUNTS.branch.username,
      password: "not-the-password",
    });

    expect(message.trim().length, "the refusal must say something").toBeGreaterThan(0);
    await expect(page).toHaveURL(/\/login$/);

    // The refusal is a refusal, not an empty session: nothing was assigned.
    const session = await apiGet<{ user: unknown }>(page, "/auth/session");
    expect(session.user).toBeNull();
  });

  test("an account in no mapped group gets an empty screen, not an error (FA-01.4)", async ({
    page,
  }) => {
    // It authenticates. It is in no directory group the platform maps onto an
    // area, so it is entitled to nothing.
    await signIn(page, ACCOUNTS.none);

    await expect(page.getByText("No areas yet")).toBeVisible();
    await expect(page.getByText(/none of its directory groups is entitled to an area/)).toBeVisible();

    // The load-bearing half: an empty screen must not be rendered as a fault.
    // Nothing to retry, nobody to escalate to, no error anywhere on the page.
    await expect(appAlerts(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    const areas = await areasFor(page);
    expect(areas).toEqual([]);
  });

  test("the entitlements are rebuilt from the directory at every login (FA-02.2)", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.none);
    await expect(page.getByText("No areas yet")).toBeVisible();
    await signOut(page);

    // Same browser, same cookie jar, a different account. Nothing of the
    // previous session may survive — the entitlement is not held in the system,
    // it is assigned to the session at login.
    await signIn(page, ACCOUNTS.branch);

    const areas = await areasFor(page);
    expect(areas.map((area) => area.name)).toContain(REFERENCE_AREA.name);
  });

  test("signing out leaves no session behind (FA-01.1)", async ({ page }) => {
    await signIn(page, ACCOUNTS.branch);
    await signOut(page);

    const session = await apiGet<{ user: unknown }>(page, "/auth/session");
    expect(session.user).toBeNull();

    // And the application itself is not reachable: no frame of it may be shown
    // to somebody who is not signed in.
    await page.goto("/areas/00000000-0000-0000-0000-000000000000");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the root account is a directory group like any other (FA-02.1)", async ({ page }) => {
    await signIn(page, ACCOUNTS.root);

    // Root is not a bigger administrator: it configures what administrators can
    // reach, which is why the administration link is here and nowhere else.
    await expect(page.getByRole("link", { name: /Areas & entitlements/ })).toBeVisible();
    await expect(page.getByText("Root account", { exact: true })).toBeVisible();

    // The fixture's root account is in the root group and in no area group, so
    // it is entitled to no area of its own — which is exactly the requirements'
    // point that these are two different jobs (§1).
    const areas = await areasFor(page);
    expect(areas.map((area) => area.name)).not.toContain(REFERENCE_AREA.name);
    expect(GROUPS.root).toBe("scriptoria-root");
  });
});
