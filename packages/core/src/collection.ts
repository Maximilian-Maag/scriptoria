import { isTerminalStatus, type Run } from "@scriptoria/contracts";

/**
 * When a view can stop asking what a run produced.
 *
 * A run reaching a terminal status is **not** the end of it. The collector
 * lists the output directory *after* the process exits, so for a moment the run
 * is finished and its results do not exist yet. A view that stopped polling at
 * the terminal status therefore stopped exactly one beat too early, and showed
 * "No result files" beside a status line that said there were four — which is
 * the opposite of what FA-09.5 asks for, and worst for the failed run somebody
 * came looking for.
 *
 * `resultCount` is the signal rather than the status: it is null until the
 * output directory has been listed and a number — possibly zero — afterwards.
 */
export const COLLECTION_GRACE_MS = 60_000;

export function collectionSettled(run: Run, now: number = Date.now()): boolean {
  if (!isTerminalStatus(run.status)) return false;

  // Collected, even if what it collected was nothing.
  if (run.resultCount !== null) return true;

  // Terminal without an end time never reached the script VM at all — there is
  // no output directory to list and nothing will ever arrive.
  if (!run.finishedAt) return true;

  // And the bound for the run whose collection failed rather than finished:
  // `resultCount` stays null in that case, and polling forever for an answer
  // that is not coming is how a closed tab becomes the only cure.
  return now - Date.parse(run.finishedAt) > COLLECTION_GRACE_MS;
}
