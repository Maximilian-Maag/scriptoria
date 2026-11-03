/**
 * The stack, before any feature is blamed for anything.
 *
 * A spec that fails because a container is down, because the migrations were
 * never applied or because the runner's key was never generated is a spec that
 * costs an hour of reading the wrong code. This one exists so that the suite
 * says which of those it is, in the first two seconds, and so that the failure
 * is attributed to the stack rather than to the feature that happened to run
 * next.
 *
 * It is also a real test of NFR-16's health endpoint: the platform raises no
 * alerts of its own, so this endpoint has to be accurate rather than reassuring.
 */
import { expect, test } from "../src/test";
import { ACCOUNTS, REFERENCE_AREA, SCRIPTS } from "../src/env";
import { areaIdFor, areasFor, apiGet, scriptByName, signIn } from "../src/ui";

test.describe("the stack the suite runs against", () => {
  test("the control plane reports its dependencies as healthy (NFR-16)", async ({ page }) => {
    const health = await apiGet<{ status: string; checks: Record<string, string> }>(
      page,
      "/health",
    );
    expect(health).toEqual({ status: "ok", checks: { database: "ok", redis: "ok" } });
  });

  test("an entitled account sees the seeded reference area (FA-11.2, FA-03.1)", async ({ page }) => {
    await signIn(page, ACCOUNTS.branch);

    const areas = await areasFor(page);
    const names = areas.map((area) => area.name);
    expect(names, `areas visible to ${ACCOUNTS.branch.username}`).toContain(REFERENCE_AREA.name);
  });

  test("the script-VM fixture's directory is reachable and its headers are read (ADR-004)", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.branch);
    const areaId = await areaIdFor(page, REFERENCE_AREA.name);

    // Reaching the catalog at all means: the backend asked the runner, the
    // runner opened SSH to the fixture, and the directory came back. A failure
    // here is a fixture problem, not a feature problem.
    const inventory = await scriptByName(page, areaId, SCRIPTS.inventory.fileName);
    expect(inventory.criticality).toBe("read-only");
    expect(inventory.interactive).toBe(false);
    expect(inventory.present).toBe(true);

    const rollout = await scriptByName(page, areaId, SCRIPTS.rollout.fileName);
    expect(rollout.criticality).toBe("modifying");
    expect(rollout.interactive).toBe(true);
    expect(rollout.present).toBe(true);
  });
});
