/**
 * FA-12 — the audit trail — and NFR-05.
 *
 * "Every run is recorded in full: who started what, where, when, with which
 * outcome" — and the requirement is a *record*, not a screen. Scriptoria has no
 * audit page and no endpoint that serves the log, deliberately: it is an
 * operational artifact, read with the tools an operator already has. So these
 * assertions read the table the application writes, in the database it writes to
 * (`src/db.ts` explains why that is the honest place to look and not a
 * shortcut).
 *
 * The four things FA-12 names are asserted as *things* rather than as rows that
 * happen to exist: an actor (the AD account, never an internal id), a subject in
 * the caller's own vocabulary, an area and a run, an outcome, and a source
 * address. A row that records an event without those is not the record the
 * requirement asks for.
 */
import { expect, test } from "../src/test";
import { ACCOUNTS, GROUPS, REFERENCE_AREA, SCRIPTS } from "../src/env";
import {
  apiDelete,
  apiPost,
  areaIdFor,
  attemptSignIn,
  expectSucceeded,
  openArea,
  selectScript,
  signIn,
  startSelectedScript,
  waitForRun,
} from "../src/ui";
import { auditRows, closeAuditDb, waitForAuditRow } from "../src/db";

interface AdminArea {
  id: string;
  name: string;
}

/** The fixture script VM's account, as an area maps it (FA-11.2). */
const SOURCE = {
  host: "localhost",
  port: 2222,
  username: "svc.scripts",
  scriptPath: "/opt/scriptoria/scripts",
  outputPath: "/opt/scriptoria/export",
};

test.afterAll(async () => {
  await closeAuditDb();
});

test.describe("the audit trail (FA-12, NFR-05)", () => {
  test("starting a run is recorded with who, what, where and which script VM (FA-12.1)", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.branch);
    await openArea(page, REFERENCE_AREA.name);
    await selectScript(page, SCRIPTS.inventory.fileName);

    const areaId = await areaIdFor(page, REFERENCE_AREA.name);
    const runId = await startSelectedScript(page);
    expectSucceeded(await waitForRun(page, runId));

    const started = await waitForAuditRow({ action: "run_started", runId });

    expect(started.actor, "who — the AD account, in the vocabulary people read").toBe(
      ACCOUNTS.branch.username,
    );
    expect(started.subject, "what — the script, as the operator named it").toBe(
      SCRIPTS.inventory.fileName,
    );
    expect(started.areaId).toBe(areaId);
    expect(started.outcome).toBe("success");
    expect(started.sourceIp, "where — the caller's address travels with the record").toBeTruthy();
    expect(started.detail, "the criticality and the host it ran on").toMatchObject({
      criticality: "read-only",
      host: "localhost",
    });
  });

  test("a refused login is recorded, and nothing is recorded when the login succeeds (FA-12.1, NFR-05)", async ({
    page,
  }) => {
    const before = await auditRows({ action: "login_succeeded", actor: ACCOUNTS.datacenter.username });

    await attemptSignIn(page, {
      username: ACCOUNTS.datacenter.username,
      password: "not-the-password",
    });

    const refused = await waitForAuditRow({
      action: "login_failed",
      actor: ACCOUNTS.datacenter.username,
    });
    expect(refused.outcome).toBe("failure");
    expect(refused.subject).toBe(ACCOUNTS.datacenter.username);
    expect(refused.detail).toMatchObject({ code: expect.any(String) });

    // A refused attempt must not mint a session, so it must not record one.
    await signIn(page, ACCOUNTS.datacenter);
    const after = await auditRows({ action: "login_succeeded", actor: ACCOUNTS.datacenter.username });
    expect(after.length, "the refused attempt recorded exactly one success — its own login").toBe(
      before.length + 1,
    );
  });

  test("stopping a run is recorded as an abort, with the stage it reached (FA-12.1, ADR-003)", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.branch);
    await openArea(page, REFERENCE_AREA.name);
    await selectScript(page, SCRIPTS.watch.fileName);

    const runId = await startSelectedScript(page);
    await waitForRun(page, runId, { until: ["running"] });

    await page.getByRole("button", { name: "Stop" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Stop it" }).click();
    const run = await waitForRun(page, runId);
    expect(run.status).toBe("aborted");

    const aborted = await waitForAuditRow({ action: "run_aborted", runId });
    expect(aborted.actor).toBe(ACCOUNTS.branch.username);
    expect(aborted.subject).toBe(SCRIPTS.watch.fileName);
    expect(aborted.outcome).toBe("success");
    expect(aborted.detail, "which stage the abort reached is part of the record").toMatchObject({
      status: expect.any(String),
    });
  });

  test("a result download is recorded, once per file (FA-12.2)", async ({ page }) => {
    await signIn(page, ACCOUNTS.branch);
    await openArea(page, REFERENCE_AREA.name);
    await selectScript(page, SCRIPTS.inventory.fileName);
    const runId = await startSelectedScript(page);
    expectSucceeded(await waitForRun(page, runId));

    const panel = page.locator("aside");
    const row = panel.locator("li").filter({ hasText: "alpha.csv" }).first();
    await expect(row).toBeVisible();

    const before = await auditRows({ action: "result_downloaded", runId });
    await Promise.all([page.waitForEvent("download"), row.getByRole("link", { name: "Download" }).click()]);

    const deadline = Date.now() + 15_000;
    let after = await auditRows({ action: "result_downloaded", runId });
    while (after.length === before.length && Date.now() < deadline) {
      await page.waitForTimeout(500);
      after = await auditRows({ action: "result_downloaded", runId });
    }

    expect(after.length, "the download is recorded when the stream is handed over").toBe(
      before.length + 1,
    );
    expect(after[0]?.subject).toBe("alpha.csv");
    expect(after[0]?.detail).toMatchObject({ sizeBytes: expect.any(Number) });
  });

  test("every administrative change is recorded, and the area's own name is the subject (FA-12.2)", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.root);
    const name = `E2E audit ${Date.now().toString(36)}`;

    const created = await apiPost<AdminArea>(page, "/admin/areas", {
      name,
      description: "Created by the end-to-end suite to be audited, then removed.",
      category: "one-off",
    });
    await apiPost<AdminArea>(page, `/admin/areas/${created.id}/sources`, SOURCE);
    await apiPost<AdminArea>(page, `/admin/areas/${created.id}/entitlements`, {
      directoryGroup: GROUPS.datacenter,
    });
    // FA-12.2 names every one of these; a grant that is not recorded is a grant
    // nobody can be asked about afterwards. Read while the area still exists:
    // the audit row's foreign key is `on delete set null`, so the moment the
    // area goes its historical rows keep the name and lose the id.
    for (const [action, subject] of [
      ["area_created", name],
      ["source_added", `${SOURCE.host}:${SOURCE.scriptPath}`],
      ["entitlement_granted", GROUPS.datacenter],
    ] as const) {
      const row = await waitForAuditRow({ action, actor: ACCOUNTS.root.username, subject });
      expect(row.areaId, `${action} must be tied to the area it changed`).toBeTruthy();
    }

    await apiDelete(page, `/admin/areas/${created.id}`);

    // The deletion's own record keeps the area by name, which is what survives:
    // the log outlives the area it is about rather than being deleted with it.
    const deleted = await waitForAuditRow({
      action: "area_deleted",
      actor: ACCOUNTS.root.username,
      subject: name,
    });
    expect(deleted.outcome).toBe("success");

    // The grant's subject is the group, not the area: the two are read
    // differently afterwards ("who could reach Data Centre?").
    const granted = await waitForAuditRow({
      action: "entitlement_granted",
      actor: ACCOUNTS.root.username,
      subject: GROUPS.datacenter,
    });
    expect(granted.detail).toMatchObject({ area: name });
  });
});
