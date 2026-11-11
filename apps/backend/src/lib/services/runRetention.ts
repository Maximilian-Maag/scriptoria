import { loadBackendConfig } from "@scriptoria/config";
import { retentionCutoff } from "@scriptoria/core";
import { runRepository } from "@scriptoria/db";

/**
 * O-5, ADR-014 — the sweep that drops terminal bytes past their retention window.
 *
 * The requirement's answer was 90 days for the transcript and indefinite for the run
 * record and the audit trail. Worth being precise about what that means here: a
 * transcript is the *only* thing this deletes. A run's row, its events, its result
 * records, the audit entries naming who started it — all of it stays, because it is
 * small and because "who ran this in March" is a question the platform should still
 * answer in May. What goes is the 2 MB of PTY bytes.
 *
 * Nothing about the run's existence disappears with it: the row keeps its size and
 * gains `prunedAt`, so the console can say the output was pruned instead of showing
 * an empty terminal as though the script had printed nothing (FA-07.5).
 */

/**
 * How many transcripts one statement prunes.
 *
 * A bound on the statement, not on the pass: a small UPDATE keeps the lock short, and
 * the pass repeats it until it stops finding work (see MAX_BATCHES_PER_PASS).
 */
const RETENTION_BATCH = 250;

/**
 * How many statements one pass may run before it yields.
 *
 * The pass repeats the batch while it keeps coming back full, so a backlog drains in
 * one pass instead of at 250 rows per interval — which, at six hours apart, is 1 000 a
 * day and could never have cleared a real backlog, let alone kept up with a deployment
 * creating more than that. The cap is what keeps a first pass over years of transcripts
 * bounded: 10 000 rows per pass, remainder next time.
 */
const MAX_BATCHES_PER_PASS = 40;

export interface RetentionOutcome {
  /** Transcripts whose bytes were dropped in this pass. */
  pruned: number;
  /** The window used, or null when retention is off. */
  cutoff: Date | null;
}

export interface RetentionOptions {
  days?: number;
  batch?: number;
  /** Statements per pass. Exposed so a test can prove the cap is honoured. */
  maxBatches?: number;
  now?: Date;
}

/**
 * Prune what the window allows.
 *
 * Deliberately does not throw at the caller: this runs on a timer, and a database
 * blip must not take the process's unhandled-rejection path. The failure is logged
 * and the next pass retries — nothing has been marked that a retry cannot finish.
 */
export async function pruneTranscripts(options: RetentionOptions = {}): Promise<RetentionOutcome> {
  const days = options.days ?? loadBackendConfig().TRANSCRIPT_RETENTION_DAYS;
  const { cutoff } = retentionCutoff(days, options.now ?? new Date());

  // Zero days is "keep everything" — the state a deployment is in when nobody has
  // decided, and the reason this check exists rather than a default of `null`.
  if (cutoff === null) return { pruned: 0, cutoff: null };

  const batch = options.batch ?? RETENTION_BATCH;
  const maxBatches = options.maxBatches ?? MAX_BATCHES_PER_PASS;

  try {
    // Drain, up to the cap. A pass that pruned exactly one batch almost certainly left
    // more behind, and the next pass is six hours away — so the loop is what makes "the
    // window is applied" true for a backlog rather than true for 250 rows.
    let pruned = 0;
    for (let pass = 0; pass < maxBatches; pass += 1) {
      const thisBatch = await runRepository.pruneTranscriptsBefore(cutoff, batch);
      pruned += thisBatch;
      if (thisBatch < batch) break;
    }

    if (pruned > 0) {
      // `warn` rather than `log`: the backend's services may only use warn/error
      // (eslint), and a deletion is the one routine action worth an operator's eye
      // in the journal.
      console.warn("pruned terminal transcripts past their retention window", {
        pruned,
        keptDays: days,
        cutoff: cutoff.toISOString(),
      });
    }

    return { pruned, cutoff };
  } catch (cause) {
    console.error("transcript retention failed — nothing was lost, the next pass retries", cause);
    return { pruned: 0, cutoff };
  }
}

/**
 * The sweep: prune now, and every interval after that.
 *
 * The first pass is what matters on a fresh deployment — a database that has been
 * accumulating transcripts without this running gets its window applied as soon as
 * the process comes up, rather than hours later.
 */
export function startRetentionSweep(): () => void {
  const intervalMs = loadBackendConfig().RETENTION_SWEEP_MS;

  const sweep = (): void => {
    void pruneTranscripts();
  };

  sweep();
  const timer = setInterval(sweep, intervalMs);
  // A timer must not be the reason a deploy waits for a shutdown.
  timer.unref();

  return () => clearInterval(timer);
}
