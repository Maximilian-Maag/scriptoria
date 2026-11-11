/**
 * O-7, ADR-013 — how many runs one script VM may be given at once.
 *
 * The scripts were written for sequential manual use. Two copies of one script
 * sharing an output directory, a lock file or a site list is not something any
 * of them promises, and the platform cannot know which of them would survive
 * it. So a script VM is given one run at a time by default, and the runs it
 * cannot take yet *wait* in `queued` — visible as a status rather than refused
 * as a mistake, because an operator who starts a second script has not done
 * anything wrong.
 *
 * The decision is a pure function, separate from the two queries that feed it,
 * for the usual reason: what is worth testing is the rule — no more than N per
 * host, oldest first — and a rule that can only be tested through a database
 * round trip is a rule tested through its own plumbing.
 */

export interface QueuedCandidate {
  id: string;
  /** The script VM. The unit the limit applies to — see ADR-013. */
  host: string;
}

/**
 * Which candidates may be admitted now.
 *
 * `candidates` arrives oldest first, and the answer preserves that order, so
 * the queue a person sees (oldest at the top) is the order runs start in.
 * `busyByHost` counts the runs a script VM is already carrying: those a worker
 * is opening a connection for, those running, and those already dispatched and
 * not yet claimed — a run on the queue is on the VM as far as capacity goes,
 * because the worker that pops it starts immediately.
 */
export function chooseAdmissions(
  candidates: readonly QueuedCandidate[],
  busyByHost: ReadonlyMap<string, number>,
  perHostLimit: number,
  batch: number,
): string[] {
  if (perHostLimit < 1 || batch < 1) return [];

  // Free slots per host, computed on first sight of that host and decremented as
  // candidates are admitted. A host that never appears in `busyByHost` has all
  // `perHostLimit` of them.
  const free = new Map<string, number>();
  const admitted: string[] = [];

  for (const candidate of candidates) {
    if (admitted.length >= batch) break;

    let available = free.get(candidate.host);
    if (available === undefined) {
      available = perHostLimit - (busyByHost.get(candidate.host) ?? 0);
      free.set(candidate.host, available);
    }

    if (available > 0) {
      admitted.push(candidate.id);
      free.set(candidate.host, available - 1);
    }
  }

  return admitted;
}
