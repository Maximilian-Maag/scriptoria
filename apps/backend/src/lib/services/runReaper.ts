import type { Run } from "@scriptoria/contracts";
import { isTerminalStatus } from "@scriptoria/contracts";
import { runRepository } from "@scriptoria/db";
import { keys, redis } from "../redis";

/**
 * FA-05 / ADR-011 — the run whose worker is gone.
 *
 * The claim key is what tells a live run from an abandoned one: a worker renews it
 * for as long as it is working, so its absence means nobody is.
 *
 * Two shapes of it, and the second is the one the explicit collection signal
 * cannot record by itself. A run still `starting` or `running` is failed. A run
 * that is *terminal* but uncollected is the worker that died between writing the
 * status and listing the output directory — nothing will record that end, and
 * without it the interface polls a run that is over for ever.
 *
 * Two callers, for two different reasons: the run reads, because a stale row only
 * matters to somebody looking at it; and dispatch (ADR-013), because a run whose
 * worker died still *occupies its script VM* as far as capacity is concerned, so
 * a doomed row would hold the whole VM against its own successors. This lives in
 * its own module rather than in the run service so that dispatch can use it
 * without importing the service that imports dispatch.
 */

/**
 * How long a worker is given to claim a run and open its connection before its
 * absence is treated as death. Comfortably longer than either takes, because
 * reaping a run that is merely slow to start would kill it for no reason.
 */
const ORPHAN_GRACE_MS = 60_000;

export async function reapIfOrphaned(run: Run): Promise<Run> {
  if (run.status === "queued") return run;

  if (isTerminalStatus(run.status)) {
    // The common case, and it costs nothing: a run that is over and has recorded
    // its collection is not worth a Redis round trip.
    if (run.resultCount !== null || run.collectedAt) return run;

    // Cheap before the round trip, and it is also what keeps this from racing the
    // collector of a run that finished a moment ago.
    const endedAt = run.finishedAt ? Date.parse(run.finishedAt) : Date.parse(run.queuedAt);
    if (Date.now() - endedAt < ORPHAN_GRACE_MS) return run;

    // A worker is still working on it (the claim is renewed while it is), so the
    // collection may yet land: leave it alone.
    if (await redis().exists(keys.runClaim(run.id))) return run;

    await runRepository.markCollectionEnded(run.id);
    return { ...run, collectedAt: new Date().toISOString() };
  }

  const held = await redis().exists(keys.runClaim(run.id));
  if (held) return run;

  // Only after a grace period: a worker that has just claimed the run writes
  // the key and the row in that order, and reaping in between would kill a run
  // that is about to start perfectly well.
  const startedAt = run.startedAt ? Date.parse(run.startedAt) : Date.parse(run.queuedAt);
  if (Date.now() - startedAt < ORPHAN_GRACE_MS) return run;

  // `collectedAt` in the same statement as the status: the collection is over
  // with the worker. The claim key is the evidence all of this rests on — a
  // worker renews it for as long as it is working, so its absence means nobody is
  // left to list the output directory.
  await runRepository.transition(
    run.id,
    "failed",
    { finishedAt: new Date(), failureReason: "worker_lost", collectedAt: new Date() },
    ["starting", "running"],
  );
  await runRepository.appendEvent(run.id, "error", "The worker holding this run is gone");

  return { ...run, status: "failed", failureReason: "worker_lost" };
}
