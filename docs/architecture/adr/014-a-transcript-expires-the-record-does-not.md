# ADR-014 — A transcript expires; the run record does not

**Status:** Accepted
**Context:** O-5, FA-07.2, NFR-05, NFR-17

## Context

One thing in this database grows without bound: the terminal transcript. It is written once per
finished run, base64 in a text column, and it is the useful part of a run — a 3000-line script's
output, a failed run's last hundred lines, the reason somebody opens a run from six weeks ago.

Everything else a run leaves is small and fixed: the row, its events, the result records (paths, not
bytes — the files stay on the script VM), the audit entries naming who started it. O-5's proposal
was therefore 90 days for the terminal bytes and *indefinite* for everything else, on the grounds
that the second is what an auditor asks about and the first is what fills a disk.

## Decision

**The bytes expire. The record stays.**

- `run_transcripts.pruned_at` is set and `content` becomes empty after
  `TRANSCRIPT_RETENTION_DAYS` (default **90**; **0 keeps everything**).
- `size_bytes` is kept, so the platform can still say how much output a run produced after the
  bytes are gone.
- The API answers `expired: true` on `/runs/{runId}/transcript`. That is the whole point of keeping
  the row: a pruned transcript and a script that deliberately printed nothing (FA-07.5) render as
  the same empty terminal, and only one of them is the platform's doing. The console says which.
- The sweep runs in the control plane: once at boot and every `RETENTION_SWEEP_MS` (default six
  hours), 250 transcripts per pass, oldest first. Nothing else is deleted — not the run, not its
  events, not its result records, not an audit entry.

The window is configuration, not a constant, because the answer belongs to whoever must answer for
the data. A deployment that has not thought about it keeps its data: `0` is a valid value and means
"never".

## Why not the alternatives

- **Delete the transcript row.** Cheaper by one row and one column, and wrong: it makes "the
  platform pruned this" indistinguishable from "this script prints nothing", which is a quiet lie
  an operator cannot check. Forty bytes to keep the distinction is not a trade-off.
- **A nightly systemd timer, like the backup.** A whole unit plus a database credential outside the
  one credential file, to run four statements. The control plane already holds that pool, already
  has a boot hook and a shutdown, and the sweep is a `setInterval`.
- **A constant of 90 days.** It is the same class of decision as the abort grace periods and the
  per-VM run limit: a number the deployment owns. A constant has to be revisited as a code change
  at the first customer who disagrees.
- **Prune on read** (drop the bytes when somebody opens a run past the window). It makes a read a
  write, and it prunes only what somebody looks at — so the disk is reclaimed by attention rather
  than by policy.

## Consequences

- FA-07.2's promise — "a run opened a month later shows what it showed while it ran" — holds for
  as long as the window, and the interface says so plainly when it has passed instead of showing
  an empty screen.
- Run history, the audit trail and the result *records* are unaffected. What disappears is the
  bytes, and a file on the script VM is still there to be collected — this deletes nothing that
  lives outside the database.
- A first pass on a database that accumulated transcripts before this existed applies the window
  immediately; it does so in batches, so a large backlog takes several passes rather than one
  statement holding a lock over the table.
- **The window has no end-to-end test, and cannot have one**: ninety days is not a test, and a
  clock stub through HTTP would prove the stub. The rule is tested as a pure function at its
  boundaries (zero, negative, one day either side), the statement against real Postgres (bytes
  gone, row kept, size kept, second pass a no-op, a recent transcript untouched), and the console's
  wording in the page's own test with a pruned response. That is the honest coverage for a
  time-based policy, and it is stated here rather than left to be discovered.
