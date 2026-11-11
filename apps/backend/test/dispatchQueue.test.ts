import { beforeEach, describe, expect, it, vi } from "vitest";
import "./support/setup";
import { sql } from "drizzle-orm";
import { db, runRepository } from "@scriptoria/db";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "./support/database";
import { seedArea } from "./support/fixtures";

/**
 * O-7 / ADR-013 — one run at a time per script VM, and the run that has to wait.
 *
 * Real Postgres, because the thing worth testing is not the arithmetic — that is
 * `chooseAdmissions` in `packages/core`, tested without a database — but that the
 * *admission and the mark* are one indivisible step, and that the capacity count
 * sees a run the moment it is dispatched rather than the moment a worker claims
 * it. A mocked repository would agree with whatever this file asserted about the
 * order of two calls.
 *
 * Redis is mocked: what leaves the control plane is a JSON job per admitted run,
 * and that is the whole of its interaction with the queue.
 */

const { lpush, claimExists } = vi.hoisted(() => ({
  lpush: vi.fn(),
  /**
   * Whether a worker holds a run's claim. The reaper asks this question before it
   * ends a run (ADR-011), and zero is the honest default here: a test that wants a
   * *live* run says so, and one that leaves it at zero is describing a VM whose
   * occupant is gone.
   */
  claimExists: vi.fn(),
}));

vi.mock("../src/lib/redis", () => ({
  keys: {
    runQueue: "scriptoria:runs:queue",
    runClaim: (id: string) => `scriptoria:run:${id}:claim`,
  },
  redis: () => ({ lpush, exists: claimExists }),
}));

const { dispatchQueuedRuns } = await import("../src/lib/services/runDispatch");

type Area = Awaited<ReturnType<typeof seedArea>>;

/** A queued run against `host`, older than the one before it by `minutesAgo`. */
async function queuedRun(area: Area, host: string, minutesAgo: number): Promise<string> {
  const run = await runRepository.createRun({
    areaId: area.areaId,
    scriptId: area.scriptId,
    scriptFileName: area.fileName,
    scriptTitle: area.fileName,
    criticality: "read-only",
    host,
    outputPath: "/opt/scriptoria/export",
    startedBy: "admin.branch",
    trigger: "manual",
    cols: 80,
    rows: 24,
  });

  // The order runs start in is the order they were queued, and `createRun` uses
  // `now()` — so the order is made explicit rather than left to two rows created
  // in the same millisecond.
  await db().execute(
    sql`update runs set queued_at = now() - (${minutesAgo} * interval '1 minute') where id = ${run.id}`,
  );

  return run.id;
}

/** What was pushed, in order. */
function pushed(): string[] {
  return lpush.mock.calls.map((call) => (JSON.parse(call[1] as string) as { runId: string }).runId);
}

/**
 * Whether the control plane marked this run as handed to the queue.
 *
 * Read through a raw query rather than the repository, because the mark is
 * internal: it is deliberately not part of the run contract, and a test that
 * asserted on the contract would need it to be. The driver hands a timestamptz
 * back as text, so "marked" is "not null" rather than an instance check.
 */
async function isDispatched(runId: string): Promise<boolean> {
  const rows = await db().execute<{ dispatched_at: string | null }>(
    sql`select dispatched_at from runs where id = ${runId}`,
  );
  return ([...rows][0]?.dispatched_at ?? null) !== null;
}

/**
 * Puts a run in the state the runner would have put it in.
 *
 * `started_at` matters: the reaper's grace period is measured from it, so a run
 * that is "running" with no start time is a row that cannot exist in production
 * and would be reaped the moment the sweeper looked at it.
 */
async function setStatus(
  runId: string,
  status: "starting" | "running" | "succeeded",
  when: "just now" | "long ago" = "just now",
): Promise<void> {
  const startedAt = when === "just now" ? sql`coalesce(started_at, now())` : sql`now() - interval '10 minutes'`;
  await db().execute(
    sql`update runs set status = ${status}, started_at = ${startedAt} where id = ${runId}`,
  );
}

beforeEach(() => {
  lpush.mockReset();
  claimExists.mockReset().mockResolvedValue(0);
});

describe("dispatching a queued run to its script VM", () => {
  it("starts the run somebody asked for when the VM is free", async () => {
    const area = await seedArea("Network");
    const runId = await queuedRun(area, "vm-a.test", 1);

    const outcome = await dispatchQueuedRuns({ perHostLimit: 1 });

    expect(outcome.admitted).toBe(1);
    expect(pushed()).toEqual([runId]);
    expect(await isDispatched(runId)).toBe(true);
  });

  it("holds the second run back while the VM is carrying one", async () => {
    const area = await seedArea("Network");
    const first = await queuedRun(area, "vm-a.test", 2);
    const second = await queuedRun(area, "vm-a.test", 1);

    await dispatchQueuedRuns({ perHostLimit: 1 });
    lpush.mockReset();

    // What a second start request, or the next sweep, would do.
    const outcome = await dispatchQueuedRuns({ perHostLimit: 1 });

    expect(outcome.admitted).toBe(0);
    expect(pushed()).toEqual([]);
    expect(await isDispatched(second)).toBe(false);
    expect(await isDispatched(first)).toBe(true);
  });

  it("starts the waiting run once the one ahead of it is over", async () => {
    const area = await seedArea("Network");
    const first = await queuedRun(area, "vm-a.test", 2);
    const second = await queuedRun(area, "vm-a.test", 1);

    await dispatchQueuedRuns({ perHostLimit: 1 });
    await setStatus(first, "running");
    lpush.mockReset();

    // Still busy: a running run occupies its VM.
    expect((await dispatchQueuedRuns({ perHostLimit: 1 })).admitted).toBe(0);

    await setStatus(first, "succeeded");
    const outcome = await dispatchQueuedRuns({ perHostLimit: 1 });

    expect(outcome.admitted).toBe(1);
    expect(pushed()).toEqual([second]);
  });

  it("does not hold one script VM up for another", async () => {
    const area = await seedArea("Network");
    const busy = await queuedRun(area, "vm-a.test", 4);
    const other = await queuedRun(area, "vm-b.test", 3);

    // The limit is per script VM, so two free VMs start two runs in one pass —
    // the alternative would be a platform-wide queue of one, which nobody asked
    // for and which one operator's long script would hold against everybody.
    await dispatchQueuedRuns({ perHostLimit: 1 });
    expect(pushed()).toEqual([busy, other]);

    // Now vm-a is carrying one and vm-b is idle: only vm-b's next run starts.
    await setStatus(busy, "running");
    await setStatus(other, "succeeded");
    const waits = await queuedRun(area, "vm-a.test", 2);
    const starts = await queuedRun(area, "vm-b.test", 1);

    lpush.mockReset();
    await dispatchQueuedRuns({ perHostLimit: 1 });

    expect(pushed()).toEqual([starts]);
    expect(await isDispatched(waits)).toBe(false);
  });

  it("admits up to a raised limit and no further", async () => {
    const area = await seedArea("Network");
    const runs = [
      await queuedRun(area, "vm-a.test", 3),
      await queuedRun(area, "vm-a.test", 2),
      await queuedRun(area, "vm-a.test", 1),
    ];

    const outcome = await dispatchQueuedRuns({ perHostLimit: 2 });

    expect(outcome.admitted).toBe(2);
    expect(pushed()).toEqual([runs[0], runs[1]]);
    expect(await isDispatched(runs[2]!)).toBe(false);
  });

  it("is idempotent while a pushed run is still on its way to a worker", async () => {
    // The mark is what makes this true: the run is queued, no worker has claimed
    // it, and a second sweep a moment later must not admit a second run into the
    // same output directory.
    const area = await seedArea("Network");
    const first = await queuedRun(area, "vm-a.test", 2);
    const second = await queuedRun(area, "vm-a.test", 1);

    await dispatchQueuedRuns({ perHostLimit: 1 });
    lpush.mockReset();

    expect((await dispatchQueuedRuns({ perHostLimit: 1 })).admitted).toBe(0);
    expect(pushed()).toEqual([]);

    // And the run that was pushed is still the one holding the slot.
    expect(await isDispatched(first)).toBe(true);
    expect(await isDispatched(second)).toBe(false);
  });

  it("releases a dispatch no worker ever answered, and tries it again", async () => {
    const area = await seedArea("Network");
    const stranded = await queuedRun(area, "vm-a.test", 1);
    // Dispatched long enough ago that no claim is still plausible: the job never
    // reached the queue, or the control plane died between the push and it.
    await db().execute(
      sql`update runs set dispatched_at = now() - interval '10 minutes' where id = ${stranded}`,
    );

    const outcome = await dispatchQueuedRuns({ perHostLimit: 1 });

    expect(outcome.released).toBe(1);
    expect(outcome.admitted).toBe(1);
    expect(pushed()).toEqual([stranded]);
  });

  it("leaves a recent dispatch alone rather than dispatching it twice", async () => {
    const area = await seedArea("Network");
    const runId = await queuedRun(area, "vm-a.test", 1);
    await db().execute(
      sql`update runs set dispatched_at = now() - interval '5 seconds' where id = ${runId}`,
    );

    const outcome = await dispatchQueuedRuns({ perHostLimit: 1 });

    expect(outcome.released).toBe(0);
    expect(outcome.admitted).toBe(0);
    expect(pushed()).toEqual([]);
  });

  it("ends a run whose worker is gone, so its script VM is not held for ever", async () => {
    // A dead worker leaves a row saying `running` and no claim behind it. Capacity
    // is counted from the rows, so without this one dead run would hold the VM
    // against every run behind it and the queue would look broken.
    const area = await seedArea("Network");
    const dead = await queuedRun(area, "vm-a.test", 5);
    await dispatchQueuedRuns({ perHostLimit: 1 });
    await setStatus(dead, "running", "long ago");
    const waiting = await queuedRun(area, "vm-a.test", 1);

    lpush.mockReset();
    const outcome = await dispatchQueuedRuns({ perHostLimit: 1 });

    expect(outcome.reaped).toBe(1);
    expect(outcome.admitted).toBe(1);
    expect(outcome.released).toBe(0);
    expect(pushed()).toEqual([waiting]);

    const rows = await db().execute<{ status: string; failure_reason: string | null }>(
      sql`select status, failure_reason from runs where id = ${dead}`,
    );
    expect([...rows][0]).toMatchObject({ status: "failed", failure_reason: "worker_lost" });
  });

  it("leaves a run alone while a worker still holds its claim", async () => {
    // The other half of the same rule: capacity must not free a VM by ending a run
    // that is genuinely running, which is what a claim says.
    const area = await seedArea("Network");
    const live = await queuedRun(area, "vm-a.test", 5);
    await dispatchQueuedRuns({ perHostLimit: 1 });
    await setStatus(live, "running", "long ago");
    await queuedRun(area, "vm-a.test", 1);

    claimExists.mockResolvedValue(1);
    lpush.mockReset();

    const outcome = await dispatchQueuedRuns({ perHostLimit: 1 });

    expect(outcome.reaped).toBe(0);
    expect(outcome.admitted).toBe(0);
    expect(pushed()).toEqual([]);
    expect(await isDispatched(live)).toBe(true);
  });

  it("hands the runs back oldest first, because that is the order they start in", async () => {
    // The caller pushes jobs in the order it is given and the runner's queue is FIFO, so
    // the order of this list is the order the scripts start in. RETURNING does not
    // preserve it on its own — it hands back rows in storage order — which showed up as
    // two ids swapped in about one run out of ten.
    const area = await seedArea("Network");
    const oldestFirst = [
      await queuedRun(area, "vm-a.test", 4),
      await queuedRun(area, "vm-a.test", 3),
      await queuedRun(area, "vm-a.test", 2),
      await queuedRun(area, "vm-a.test", 1),
    ];

    const admitted = await runRepository.admitForDispatch(4, 10);

    expect(admitted.map((run) => run.id)).toEqual(oldestFirst);
  });

  it("waits for the dispatch lock instead of deciding alongside another dispatcher", async () => {
    // The property the single lock exists for, and the only way to assert it from one
    // process: hold the lock from another connection and prove admission blocks on
    // it. Remove the lock and this test resolves immediately — which is exactly the
    // failure it is here to catch (a per-host lock set was not enough, because the
    // hosts to lock came from a query).
    const area = await seedArea("Network");
    const runId = await queuedRun(area, "vm-a.test", 1);

    const blocker = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      await blocker.unsafe("begin");
      // The same constant the repository takes: 4_812_013_001 in DISPATCH_LOCK.
      await blocker.unsafe("select pg_advisory_xact_lock(4812013001)");

      const admission = runRepository.admitForDispatch(1, 10);

      const winner = await Promise.race([
        admission.then(() => "admitted" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 300)),
      ]);
      expect(winner, "a second dispatcher waits rather than deciding").toBe("blocked");

      await blocker.unsafe("commit");

      const admitted = await admission;
      expect(admitted.map((run) => run.id)).toEqual([runId]);
    } finally {
      await blocker.end({ timeout: 5 });
    }
  });
});
