import { describe, expect, it } from "vitest";
import { listAreas } from "@/lib/services/areaService";
import { getRun, listRuns } from "@/lib/services/runService";
import { queryAuditLog } from "@/lib/services/auditService";
import { auditRepository } from "@scriptoria/db";
import { seedArea, seedRun, session } from "./support/fixtures";

/**
 * FA-02.4 and NFR-18 — the boundary the whole product rests on.
 *
 * An administrator sees the areas, scripts, runs and results their groups
 * reach, and nothing else. This is the one property where a bug is both
 * invisible in normal use and serious: every screen looks right to the person
 * who has the entitlement, and wrong only to the person who does not — who is
 * exactly the person nobody tests as.
 *
 * So each of these seeds *two* areas and asks as somebody entitled to one.
 */
describe("what an administrator can reach", () => {
  it("lists only the areas their session carries", async () => {
    const mine = await seedArea("Mine");
    const theirs = await seedArea("Theirs");

    const result = await listAreas(session({ areaIds: [mine.areaId] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((area) => area.name)).toEqual(["Mine"]);
    expect(result.value.map((area) => area.id)).not.toContain(theirs.areaId);
  });

  /**
   * FA-01.4 — an empty area set is a valid session, and it must produce an empty
   * list rather than an unfiltered one. An `IN ()` that degrades to "no filter"
   * is the classic way this goes wrong, and it fails open.
   */
  it("shows an account entitled to nothing exactly nothing", async () => {
    await seedArea("Mine");
    await seedArea("Theirs");

    const areas = await listAreas(session({ areaIds: [] }));
    const runs = await listRuns(session({ areaIds: [] }), { limit: 50, offset: 0 });

    expect(areas.ok && areas.value).toEqual([]);
    expect(runs.ok && runs.value.items).toEqual([]);
  });

  it("lists only runs from areas their session carries", async () => {
    const mine = await seedArea("Mine");
    const theirs = await seedArea("Theirs");
    await seedRun(mine, "admin.branch");
    await seedRun(theirs, "admin.datacenter");

    const result = await listRuns(session({ areaIds: [mine.areaId] }), { limit: 50, offset: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(1);
    expect(result.value.items.map((run) => run.areaId)).toEqual([mine.areaId]);
  });

  /**
   * A run in an area the caller cannot reach answers 404 rather than 403, and
   * the difference matters: a 403 confirms that the run exists, which is itself
   * a disclosure to somebody who should not know.
   */
  it("answers not-found — not forbidden — for a run in another area", async () => {
    const mine = await seedArea("Mine");
    const theirs = await seedArea("Theirs");
    const hidden = await seedRun(theirs, "admin.datacenter");

    const result = await getRun(session({ areaIds: [mine.areaId] }), hidden.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });

  it("is not widened by asking for another area explicitly", async () => {
    const mine = await seedArea("Mine");
    const theirs = await seedArea("Theirs");
    await seedRun(theirs, "admin.datacenter");

    const result = await listRuns(session({ areaIds: [mine.areaId] }), {
      areaId: theirs.areaId,
      limit: 50,
      offset: 0,
    });

    expect(result.ok && result.value.items).toEqual([]);
  });
});

/**
 * FA-12. The audit log is the root account's, and the service is deliberately
 * unbounded — the route above it is `requireRoot`, and a log narrowed to the
 * reader's own entitlements is not an audit log. These pin that intent, so that
 * "it filters by nothing" stays a decision rather than becoming a surprise.
 */
describe("the audit log", () => {
  it("returns entries from every area, because it is root's view", async () => {
    const mine = await seedArea("Mine");
    const theirs = await seedArea("Theirs");

    await auditRepository.record({ actor: "a", action: "run_started", areaId: mine.areaId });
    await auditRepository.record({ actor: "b", action: "run_started", areaId: theirs.areaId });

    const result = await queryAuditLog({ limit: 100, offset: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(2);
  });

  it("filters by actor, action and area, and pages", async () => {
    const area = await seedArea("Mine");
    for (let i = 0; i < 3; i++) {
      await auditRepository.record({ actor: "a", action: "login_succeeded" });
    }
    await auditRepository.record({ actor: "b", action: "area_created", areaId: area.areaId });

    const byActor = await queryAuditLog({ actor: "a", limit: 100, offset: 0 });
    const byAction = await queryAuditLog({ action: "area_created", limit: 100, offset: 0 });
    const byArea = await queryAuditLog({ areaId: area.areaId, limit: 100, offset: 0 });
    const paged = await queryAuditLog({ actor: "a", limit: 2, offset: 2 });

    expect(byActor.ok && byActor.value.total).toBe(3);
    expect(byAction.ok && byAction.value.total).toBe(1);
    expect(byArea.ok && byArea.value.total).toBe(1);
    // `total` is the size of the whole result, not of the page — that is the
    // one number a pager cannot work out for itself.
    expect(paged.ok && paged.value.total).toBe(3);
    expect(paged.ok && paged.value.items.length).toBe(1);
  });

  /**
   * An audit write must never be able to fail the thing it is recording: the
   * record is a fact about something that already happened.
   */
  it("swallows its own failure rather than failing the caller", async () => {
    await expect(
      auditRepository.record({
        actor: "a",
        action: "run_started",
        // No such area. The insert violates a foreign key and the caller is
        // told nothing, because the run it was recording already happened.
        areaId: "00000000-0000-0000-0000-000000000000",
      }),
    ).resolves.toBeUndefined();
  });
});
