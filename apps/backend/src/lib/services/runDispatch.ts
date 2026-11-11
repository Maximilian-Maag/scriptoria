import type { RunJob } from "@scriptoria/contracts";
import { runRepository } from "@scriptoria/db";
import { loadBackendConfig } from "@scriptoria/config";
import { keys, redis } from "../redis";
import { reapIfOrphaned } from "./runReaper";

/**
 * O-7, ADR-013 — the one place that hands a queued run to the runner.
 *
 * A run does not start because somebody pressed Start; it starts because this
 * admitted it to a script VM that had room. The two are a second apart at most,
 * and the difference only shows when a VM is already carrying a run — which is
 * exactly the case the platform has to get right rather than the one it can
 * afford to be casual about: the scripts were written for sequential manual use,
 * and two of them sharing an output directory is not something any of them
 * promises.
 *
 * The admission itself is a transaction in the repository (it has to see the
 * capacity and write the mark indivisibly). This module is the part that then
 * pushes the jobs, plus the sweep that keeps the queued ones moving.
 */

/**
 * How many queued runs one sweep looks at.
 *
 * Only the first `batch` by queue time are considered, which is a bound on the
 * query rather than on the queue: a backlog larger than this is dispatched over
 * successive sweeps, oldest first, in the order they would have started anyway.
 */
const DISPATCH_BATCH = 200;

/**
 * How long a dispatched run may sit unclaimed before its mark is treated as
 * stale and the run is released to be dispatched again.
 *
 * A worker normally claims within milliseconds of the push. The grace exists for
 * the two cases that are not normally: a worker that is still starting, and a
 * job that never reached the queue at all — where, without this, the run would
 * hold its script VM for ever.
 */
const DISPATCH_STALE_SECONDS = 90;

export interface DispatchOutcome {
  /** Runs pushed to the queue in this pass. */
  admitted: number;
  /** Runs whose earlier dispatch had gone unanswered and were released. */
  released: number;
  /** Runs whose worker was gone, ended so they stop occupying their script VM. */
  reaped: number;
}

/**
 * Free the script VMs whose occupants are not really there.
 *
 * A run whose worker died leaves a row saying `running` and no claim behind it, and
 * capacity is counted from those rows — so without this, one dead worker would hold
 * its script VM against every run behind it, for ever, and the queue would look like
 * a platform that had stopped working. The question "is this run real" is ADR-011's,
 * with its own grace period and its own evidence (the claim key), so it is asked
 * there rather than re-invented here.
 *
 * Only VMs at their limit are looked at, and only when something is waiting: an
 * idle platform with room everywhere does no Redis round trips at all.
 */
async function recoverWedgedHosts(perHostLimit: number): Promise<number> {
  if ((await runRepository.countQueued()) === 0) return 0;

  const byHost = new Map<string, string[]>();
  for (const run of await runRepository.listActiveByHost()) {
    const ids = byHost.get(run.host) ?? [];
    ids.push(run.id);
    byHost.set(run.host, ids);
  }

  let reaped = 0;
  for (const [host, ids] of byHost) {
    if (ids.length < perHostLimit) continue;

    for (const id of ids) {
      const run = await runRepository.getRun(id);
      if (!run) continue;

      const after = await reapIfOrphaned(run);
      if (after.status === "failed" && run.status !== "failed") {
        reaped += 1;
        console.warn("ended a run whose worker was gone, freeing its script VM", {
          runId: id,
          host,
        });
      }
    }
  }

  return reaped;
}

/**
 * Admit what a script VM can take, and push it.
 *
 * Deliberately does not throw at the caller: a run that could not be dispatched
 * is *queued*, which is a legitimate state, and the sweep will try again. What it
 * must not do is fail a start request that has already created the run — that
 * would leave a run the operator was told had started and nothing to carry it.
 */
export async function dispatchQueuedRuns(
  options: { perHostLimit?: number; batch?: number } = {},
): Promise<DispatchOutcome> {
  const perHostLimit = options.perHostLimit ?? loadBackendConfig().MAX_CONCURRENT_RUNS_PER_HOST;
  const batch = options.batch ?? DISPATCH_BATCH;

  try {
    const released = await runRepository.releaseStaleDispatches(DISPATCH_STALE_SECONDS);
    if (released.length > 0) {
      // A warning rather than chatter: this says a job never reached a worker,
      // which is either a lost queue entry or a control plane that died between
      // the push and the claim. Both are worth an operator's eye.
      console.warn("released dispatched runs no worker claimed", {
        count: released.length,
        runIds: released,
      });
    }

    const reaped = await recoverWedgedHosts(perHostLimit);
    const admitted = await runRepository.admitForDispatch(perHostLimit, batch);

    for (const run of admitted) {
      const job: RunJob = { runId: run.id, queuedAt: run.queuedAt.toISOString() };
      await redis().lpush(keys.runQueue, JSON.stringify(job));
    }

    return { admitted: admitted.length, released: released.length, reaped };
  } catch (cause) {
    // A failure here leaves the runs queued rather than lost: nothing has been
    // marked that the sweep cannot release, and nothing has been pushed that the
    // runner cannot discard.
    console.error("dispatch failed — queued runs stay queued", cause);
    return { admitted: 0, released: 0, reaped: 0 };
  }
}

/**
 * The sweep: dispatch now, and every interval after that.
 *
 * Runs waiting for a script VM are started by this, not by the request that
 * created them, so it has to run even when nobody is starting anything — the
 * common case is a VM that frees up while the operator is watching a queued run.
 * The boot pass is the other half: runs queued while the control plane was down
 * are dispatched as soon as it comes back, without waiting for an interval.
 */
export function startDispatchSweep(): () => void {
  const intervalMs = loadBackendConfig().DISPATCH_SWEEP_MS;

  const sweep = (): void => {
    void dispatchQueuedRuns();
  };

  sweep();
  const timer = setInterval(sweep, intervalMs);
  // A timer must not be the reason a deploy has to wait for a shutdown.
  timer.unref();

  return () => clearInterval(timer);
}
