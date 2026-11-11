/**
 * O-5, ADR-014 — when a run's terminal transcript stops being kept.
 *
 * The requirement proposed 90 days for the terminal bytes and *indefinite* for
 * run records and audit entries, on the grounds that the first is the only thing
 * that grows without bound and the other two are small. This is that calculation,
 * and nothing else: the policy is a number in a deployment's configuration, so a
 * customer whose transcripts matter for longer changes a value rather than asking
 * for a release.
 *
 * Zero (or anything below it) means keep everything. That is deliberately the
 * shape a number takes when the answer is "not yet decided" — a deployment that
 * has not thought about retention ends up keeping its data, not deleting it.
 */

/** How long a transcript is kept, in days, from when it was persisted. */
export const RETENTION_DEFAULT_DAYS = 90;

export interface RetentionCutoff {
  /** Rows persisted before this instant may be pruned. Null = keep everything. */
  cutoff: Date | null;
}

/**
 * The instant a transcript has to beat to survive, or null when nothing may be
 * pruned.
 *
 * `now` is a parameter rather than `Date.now()` so the rule can be tested at the
 * boundaries — exactly 90 days, one millisecond either side — without a fake timer
 * and without waiting.
 */
export function retentionCutoff(days: number, now: Date): RetentionCutoff {
  if (!Number.isFinite(days) || days <= 0) return { cutoff: null };

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { cutoff };
}
