import { isTerminalStatus, type Run } from "@scriptoria/contracts";

/**
 * When a view can stop asking what a run produced.
 *
 * A run reaching a terminal status is **not** the end of it. The collector lists
 * the output directory *after* the process exits, so for a moment the run is
 * finished and its results do not exist yet. A view that stopped polling at the
 * terminal status therefore stopped exactly one beat too early, and showed
 * "No result files" beside a status line that said there were four — which is
 * the opposite of what FA-09.5 asks for, and worst for the failed run somebody
 * came looking for.
 *
 * Two facts answer it, and both are recorded rather than inferred. `resultCount`
 * is what was found. `collectedAt` is that the looking is *over*, written by
 * whoever ends a collection on any path it can end by: the listing, the listing
 * **failing** (which ends with no count at all), a run cancelled before a worker
 * claimed it, and a run whose worker was reaped.
 *
 * Neither is a clock. An earlier version of this stopped once a fixed interval
 * had passed since `finishedAt`, which turned "this collection is taking a
 * while" — hundreds of files fetched one at a time over SFTP is the normal case,
 * not an exceptional one — into "there is nothing to show", permanently.
 */
export function collectionSettled(run: Run): boolean {
  if (!isTerminalStatus(run.status)) return false;

  // Collected, even if what it collected was nothing.
  if (run.resultCount !== null) return true;

  // Ended without a count: the collection failed, or the platform decided none
  // is coming. Either way there is nothing left to wait for.
  //
  // Truthiness rather than `!== null`, and for the same reason the count is
  // checked that way above: a payload that predates this field — a frontend
  // talking to a backend that has not been replaced yet — would otherwise read as
  // "collected" on the strength of a field that is not there, and stop asking
  // about a run that is still producing.
  if (run.collectedAt) return true;

  // Terminal without an end time never reached the script VM at all — there is
  // no output directory to list and nothing will ever arrive.
  return !run.finishedAt;
}
