import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "@scriptoria/contracts";

/**
 * A run whose worker is gone, and the two shapes of that (ADR-011).
 *
 * The claim key is the evidence: a worker renews it for as long as it is working,
 * so its absence means nobody is left to list the output directory. What the
 * reaper does about that differs by status, and the second case is the one the
 * explicit collection signal cannot record by itself — a worker that died
 * between writing the run's terminal status and writing the collection's end.
 *
 * The repositories and Redis are mocked; the decision is not.
 */

const { transition, appendEvent, markCollectionEnded, exists } = vi.hoisted(() => ({
  transition: vi.fn(),
  appendEvent: vi.fn(),
  markCollectionEnded: vi.fn(),
  exists: vi.fn(),
}));

vi.mock("@scriptoria/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scriptoria/db")>();
  return {
    ...actual,
    runRepository: {
      ...actual.runRepository,
      transition,
      appendEvent,
      markCollectionEnded,
    },
  };
});

vi.mock("../src/lib/redis", () => ({
  keys: { runClaim: (id: string) => `scriptoria:run:${id}:claim` },
  redis: () => ({ exists }),
}));

const { reapIfOrphaned } = await import("../src/lib/services/runService");

const RUN_ID = "11111111-1111-4111-8111-111111111111";

/** Well past `ORPHAN_GRACE_MS` (60s), so a bound that is going to expire has. */
const LONG_AGO = new Date(Date.now() - 10 * 60_000).toISOString();

const run = (over: Partial<Run> = {}): Run =>
  ({
    id: RUN_ID,
    areaId: "area-1",
    scriptId: "script-1",
    scriptFileName: "inventory-report.sh",
    scriptTitle: "Inventory",
    criticality: "read-only",
    status: "running",
    trigger: "manual",
    startedBy: "admin.branch",
    host: "vm1.example.test",
    queuedAt: LONG_AGO,
    startedAt: LONG_AGO,
    finishedAt: null,
    exitCode: null,
    failureReason: null,
    lastStreamId: null,
    resultCount: null,
    collectedAt: null,
    ...over,
  }) as Run;

beforeEach(() => {
  transition.mockReset().mockResolvedValue(true);
  appendEvent.mockReset();
  markCollectionEnded.mockReset();
  exists.mockReset().mockResolvedValue(0);
});

describe("reaping a run whose worker is gone", () => {
  it("fails a run that is still starting, and ends its collection in the same write", async () => {
    const reaped = await reapIfOrphaned(run({ status: "starting" }));

    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition.mock.calls[0]?.[1]).toBe("failed");
    expect(transition.mock.calls[0]?.[2]).toMatchObject({
      failureReason: "worker_lost",
      collectedAt: expect.any(Date),
    });
    expect(reaped.status).toBe("failed");
  });

  it("leaves a run alone while a worker holds its claim", async () => {
    exists.mockResolvedValue(1);

    const reaped = await reapIfOrphaned(run({ status: "starting" }));

    expect(transition).not.toHaveBeenCalled();
    expect(reaped.status).toBe("starting");
  });

  /**
   * The case no other write covers: the runner records the run's terminal status
   * *before* it lists the output directory, so a worker that died in between
   * leaves a run that is finished and looks like it is still producing.
   */
  it("records the collection as over for a terminal run that was never collected", async () => {
    const reaped = await reapIfOrphaned(
      run({ status: "succeeded", finishedAt: LONG_AGO, exitCode: 0 }),
    );

    expect(markCollectionEnded).toHaveBeenCalledWith(RUN_ID);
    expect(reaped.collectedAt).not.toBeNull();
    // Not a status change: the run ended the way it ended.
    expect(transition).not.toHaveBeenCalled();
  });

  it("leaves a terminal run alone when a worker is still collecting it", async () => {
    exists.mockResolvedValue(1);

    const reaped = await reapIfOrphaned(run({ status: "succeeded", finishedAt: LONG_AGO }));

    expect(markCollectionEnded).not.toHaveBeenCalled();
    expect(reaped.collectedAt).toBeNull();
  });

  it("gives the collection its grace period before deciding a terminal run is over", async () => {
    // Finished a moment ago: the collector may still be working, and the claim
    // is not even consulted for this — the elapsed bound is the cheap check.
    const justNow = new Date(Date.now() - 1_000).toISOString();

    await reapIfOrphaned(run({ status: "succeeded", finishedAt: justNow }));

    expect(markCollectionEnded).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });

  it("does not touch a terminal run that already recorded its collection", async () => {
    await reapIfOrphaned(run({ status: "succeeded", finishedAt: LONG_AGO, resultCount: 4 }));
    await reapIfOrphaned(
      run({ status: "succeeded", finishedAt: LONG_AGO, collectedAt: LONG_AGO }),
    );

    expect(markCollectionEnded).not.toHaveBeenCalled();
    // The common case, and it costs no Redis round trip.
    expect(exists).not.toHaveBeenCalled();
  });

  it("never touches a queued run — it has not been claimed by anybody yet", async () => {
    await reapIfOrphaned(run({ status: "queued", startedAt: null }));

    expect(transition).not.toHaveBeenCalled();
    expect(markCollectionEnded).not.toHaveBeenCalled();
  });
});
