# ADR-013 — One run at a time per script VM, admitted by the control plane

**Status:** Accepted
**Context:** FA-05, O-7, ADR-001

## Context

The scripts this platform starts were written for sequential manual use. They write into an
output directory, some of them take a lock file, and none of them promises that two copies can
share either. Until now the only limit was `RUNNER_CONCURRENCY`, which is how many PTYs one
runner worker holds — a bound on *the worker*, not on the machine being touched. Two workers, or
two slots in one worker, would open two PTYs on one script VM and let two scripts write into the
same directory.

O-7 asked the question the platform cannot answer for the script owner: how many runs one script
VM tolerates. The answer is per VM, because that is the machine whose filesystem and locks are
shared, and it defaults to one.

## Decision

**The control plane admits a queued run to a script VM, and the admission is a database
transaction that takes an advisory lock per host.**

- A run is still created in `queued`, and a start request still returns immediately — but a start
  request no longer pushes a job. It calls the dispatcher, which decides how much the run's
  script VM can take: `starting`, `running`, and *dispatched but not yet claimed* all count as
  occupying it.
- The limit is `MAX_CONCURRENT_RUNS_PER_HOST`, default **1**, per script VM. It is configuration
  rather than a constant because it is the script owner's number and because the fixture's scripts
  are not the production ones.
- A run that does not fit **waits** in `queued`. It is not refused: an operator who starts a
  second script has done nothing wrong, and a status line they can watch is a better answer than
  a rule they cannot see.
- Admission and the dispatch mark (`runs.dispatched_at`) are written in one transaction holding a
  **single dispatch-wide advisory lock**. That is what stops two control-plane processes — or a
  start request and a sweep — from each believing the VM has one free slot and admitting a run
  into it. One lock rather than one per script VM because a per-host set cannot be taken safely:
  the hosts come from a query, and a run for a host created after that query would be admitted
  with no lock held for it. Dispatch is four short queries; serialising it costs nothing that
  matters.
- A mark older than 90 seconds on a still-queued run is released and the run dispatched again.
  That is the recovery path for a job that never reached the queue, and the reason a mark can
  never hold a VM for ever.
- A sweep every `DISPATCH_SWEEP_MS` (default 5 s), plus one pass at boot, dispatches the runs a
  busy VM held back. The boot pass is also what recovers runs queued while the control plane was
  down.

The decision itself — how many, per host, oldest first — is `chooseAdmissions` in
`packages/core`, a pure function, so the rule is tested without a database and the transaction is
tested without re-asserting the rule.

## Why not the alternatives

- **A semaphore in the runner.** The process that opens the PTY would take a slot from Redis and
  release it when done. It puts the limit where the PTY is, but it makes the *consumer* the place
  that knows about capacity, and a runner that is busy with a slot can no longer be reasoned
  about from the queue alone: a job popped by a worker that then waits for a slot is a job
  occupying a worker while doing nothing. The control plane already owns dispatch and already has
  the database where the truth lives.
- **Refusing the start with a 409.** Simpler, and it makes the operator the scheduler: they would
  have to retry, and "when is it free?" becomes their question. The queued state exists in the
  state machine already, and FA-05's own list shows it.
- **A fixed constant of one.** The question O-7 asks is per VM and the answer will differ between
  a script VM that runs a dozen sequential scripts and one that runs something else. A constant
  would have to be revisited as a code change at the first deployment that disagrees.
- **A `dispatching` status.** A fourth live state to keep in step across the contracts, the
  status line and the terminal gateway, for one bit that only the dispatcher needs. The mark is
  internal and stays out of the contract.

## Consequences

- Two runs against one script VM are impossible by construction, and the second is visible as
  `queued` rather than lost. The delay an operator sees when a run ends is at most one sweep
  (5 s by default).
- Capacity is counted from the database on every sweep, which is one indexed query per host. The
  index is `runs(host, status)`.
- A control plane that dies between the mark and the claim leaves the run queued with a mark; the
  release path picks it up within 90 seconds. A duplicate job for one run is harmless — the
  runner's claim is `SET NX`, so the second worker discards it instead of opening a second PTY.
- Raising the limit is a configuration change on the control plane, not a code change, and takes
  effect on the next sweep.
- `RUNNER_CONCURRENCY` keeps its meaning — PTYs per worker — and stops being the only thing
  standing between two scripts and one output directory.
