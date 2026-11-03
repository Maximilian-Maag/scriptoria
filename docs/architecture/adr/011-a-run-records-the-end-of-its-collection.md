# ADR-011 — A run records the end of its own collection

**Status:** Accepted
**Context:** FA-09.5, FA-12.1, ADR-003

## Context

A run reaching a terminal status is not the end of it. The runner writes the run's terminal
status and *then* lists the output directory, so between the two there is a window in which the
run is over and its results do not exist yet. A view that stops asking at the terminal status
stops one beat too early and shows "No result files" beside a status line that says four —
worst of all for the failed run somebody came looking for, which is exactly what FA-09.5 asks
not to do.

The first answer was a number: `resultCount`, null until the collector has looked. That covers
the collection that worked. It does not cover the collection that *failed* — which ends with no
count at all, and therefore looked identical to one still running — so the interface was given a
bound as well: stop once `finishedAt` is a minute old.

That bound is a guess about somebody else's work, and the product's ordinary case is the one it
guesses wrong. A run that writes hundreds of files across dozens of sites is fetched one file at
a time over SFTP; a collection that takes longer than the interval is reported to the user as a
run that produced nothing, permanently, because the polling has stopped and nothing restarts it.

## Decision

The end of the collection is **recorded, not inferred**. `runs.collected_at` is written by
whoever ends a collection, on every path one can end by:

- the runner, after the results are persisted, alongside the count;
- the runner, in the `catch` that today only appended an event — a collection that failed is
  over, and the interface must be able to tell that from one that is still going;
- the control plane, when a queued run is cancelled before a worker claimed it: nothing was
  started, so there is no output directory and no collection coming;
- the control plane, when `reapIfOrphaned` declares a worker lost: the claim key is renewed
  while a worker is working, so its absence is the same evidence that ends the run.

`collectionSettled` reads two facts and a status, and no clock: the run is terminal, and either a
count exists or the collection has recorded its end. `COLLECTION_GRACE_MS` is gone.

## Why not the alternatives

- **A longer interval.** It moves the window rather than closing it, and the case it fails on
  is the one the platform exists for. It also cannot distinguish "still working" from "the
  worker died", which is the only thing a bound is actually good for.
- **A collection state enum** (`pending`/`complete`/`failed`). A third value to keep in step for
  one bit of information, and the difference between `complete` and `failed` is already visible
  in whether a count came with it.
- **A second event row.** The collection's outcome is already appended to `run_events`, but an
  event is a *log*: reading the last one to decide whether to keep polling means parsing prose,
  and a log written for people is not an interface for the interface.

## Consequences

- One column, one writer per path, and the interface reads a fact. A view cannot be wrong about
  whether a collection is over any more; it can only be out of date by one poll.
- Nothing polls for ever. The case that motivated the old bound — a collection that fails —
  now ends by recording that it ended.
- A worker that dies mid-collection leaves `collected_at` null until `reapIfOrphaned` runs,
  which happens on the next read of the run. A view polls the run, so the read that shows it
  the run is also the read that ends it.
- `reapIfOrphaned` rests on the claim key, and so does this: a worker whose claim lapses while
  it is still collecting would be declared gone, and its results, when they arrive, would no
  longer be waited for. That risk is the one the reaper already takes to end the run — this
  adds no new one — and the claim is renewed for as long as a worker is working.
