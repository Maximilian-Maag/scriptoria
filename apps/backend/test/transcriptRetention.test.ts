import { beforeEach, describe, expect, it } from "vitest";
import "./support/setup";
import { sql } from "drizzle-orm";
import { db, runRepository } from "@scriptoria/db";
import { seedArea, seedRun } from "./support/fixtures";

/**
 * O-5 / ADR-014 — terminal transcripts expire; run records and audit entries do not.
 *
 * Real Postgres, because the thing worth testing is what the statement does to a row:
 * that the bytes go, that the record stays, and that a second pass does nothing. The
 * window itself is a pure function (`retentionCutoff` in `packages/core`, tested at
 * its boundaries without a clock).
 *
 * The line this file exists to hold: **a pruned transcript must remain
 * distinguishable from a run that printed nothing.** If pruning deleted the row, the
 * console would show an empty terminal for a 2 MB run and call it a script that said
 * nothing (FA-07.5) — a quiet lie the operator has no way to check.
 */

const TRANSCRIPT = Buffer.from("Reading interfaces across 42 sites\n").toString("base64");

async function transcriptOf(runId: string) {
  const rows = await db().execute<{
    content: string;
    size_bytes: string;
    pruned_at: string | null;
  }>(sql`select content, size_bytes, pruned_at from run_transcripts where run_id = ${runId}`);
  return [...rows][0] ?? null;
}

/** Backdates the persisted instant, which is what the window is measured from. */
async function persistAgo(runId: string, days: number): Promise<void> {
  await db().execute(
    sql`update run_transcripts set persisted_at = now() - (${days} * interval '1 day') where run_id = ${runId}`,
  );
}

describe("pruning terminal transcripts", () => {
  let oldRun: string;
  let recentRun: string;

  beforeEach(async () => {
    const area = await seedArea("Network");
    const old = await seedRun(area, "admin.branch");
    const recent = await seedRun(area, "admin.branch");
    oldRun = old.id;
    recentRun = recent.id;

    await runRepository.saveTranscript(oldRun, TRANSCRIPT, TRANSCRIPT.length, false);
    await runRepository.saveTranscript(recentRun, TRANSCRIPT, TRANSCRIPT.length, false);
    await persistAgo(oldRun, 120);
  });

  it("drops the bytes of a transcript past the window and keeps the record", async () => {
    const { pruneTranscripts } = await import("../src/lib/services/runRetention");

    const outcome = await pruneTranscripts({ days: 90 });
    expect(outcome.pruned).toBe(1);

    const pruned = await transcriptOf(oldRun);
    expect(pruned).not.toBeNull(); // the row stays: "this was pruned" is a fact, not silence
    expect(pruned!.content).toBe("");
    expect(pruned!.pruned_at).not.toBeNull();
    expect(Number(pruned!.size_bytes)).toBe(TRANSCRIPT.length); // still says how much was there

    // The run itself — its row, its events, its place in the history — is untouched.
    const run = await runRepository.getRun(oldRun);
    expect(run).not.toBeNull();
    expect(run!.scriptFileName).toBeTruthy();
  });

  it("leaves a transcript inside the window alone", async () => {
    const { pruneTranscripts } = await import("../src/lib/services/runRetention");
    await pruneTranscripts({ days: 90 });

    const recent = await transcriptOf(recentRun);
    expect(recent!.content).toBe(TRANSCRIPT);
    expect(recent!.pruned_at).toBeNull();
  });

  it("is idempotent: a second pass finds nothing left to prune", async () => {
    const { pruneTranscripts } = await import("../src/lib/services/runRetention");

    expect((await pruneTranscripts({ days: 90 })).pruned).toBe(1);
    // The count is what a sweep logs, so it must not keep reporting work it did not do.
    expect((await pruneTranscripts({ days: 90 })).pruned).toBe(0);
  });

  it("keeps everything at zero days, which is an undecided deployment", async () => {
    const { pruneTranscripts } = await import("../src/lib/services/runRetention");

    const outcome = await pruneTranscripts({ days: 0 });
    expect(outcome).toEqual({ pruned: 0, cutoff: null });

    const old = await transcriptOf(oldRun);
    expect(old!.content).toBe(TRANSCRIPT);
  });

  it("reports the window it used, so a log line can be checked against the config", async () => {
    const { pruneTranscripts } = await import("../src/lib/services/runRetention");
    const now = new Date("2026-11-11T12:00:00.000Z");

    const outcome = await pruneTranscripts({ days: 30, now });
    expect(outcome.cutoff?.toISOString()).toBe("2026-10-12T12:00:00.000Z");
  });

});

/**
 * How much one pass gets through, which is the half of retention that a single batch
 * could not do: at six hours apart, 250 rows a pass is 1 000 transcripts a day — a
 * backlog that never clears and a deployment creating more that never catches up.
 *
 * A separate block because these count rows: the tests above start from a seeded area
 * of their own, and adding to it would make the arithmetic here about the fixture.
 */
describe("draining a backlog in one pass", () => {
  async function oldTranscripts(count: number): Promise<string[]> {
    const area = await seedArea("Retention backlog");
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const run = await seedRun(area, "admin.branch");
      await runRepository.saveTranscript(run.id, TRANSCRIPT, TRANSCRIPT.length, false);
      await persistAgo(run.id, 120);
      ids.push(run.id);
    }
    return ids;
  }

  it("repeats the statement until the backlog is gone", async () => {
    const ids = await oldTranscripts(5);

    const { pruneTranscripts } = await import("../src/lib/services/runRetention");
    const outcome = await pruneTranscripts({ days: 90, batch: 2 });

    expect(outcome.pruned).toBe(5);
    for (const id of ids) expect((await transcriptOf(id))!.content).toBe("");
  });

  it("stops at the cap, so one pass over years of transcripts stays bounded", async () => {
    await oldTranscripts(5);

    const { pruneTranscripts } = await import("../src/lib/services/runRetention");
    // One statement of two rows: the rest waits for the next pass rather than running an
    // unbounded number of statements inside one timer callback.
    const outcome = await pruneTranscripts({ days: 90, batch: 2, maxBatches: 1 });

    expect(outcome.pruned).toBe(2);
  });
});
