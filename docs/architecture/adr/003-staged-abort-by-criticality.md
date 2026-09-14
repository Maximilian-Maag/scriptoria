# ADR-003 — Staged abort, signalled to the process group, gated on criticality

**Status:** Proposed · closes open decision O-2
**Context:** FA-08, NFR-05, NFR-06

## Context

An administrator must be able to stop a run (FA-08.1), and interactive scripts must be
stoppable at all because they run as loops with no natural end (FA-08.2). The semantics are not
a detail: a modifying script killed halfway through leaves the estate in a state nobody
described, and "halfway through" can mean hundreds of sites changed and hundreds not.

There is also a mechanical problem. The obvious implementation — send a signal down the SSH
channel — does not reliably work: an OpenSSH server commonly ignores the channel signal
message, and even when it does not, the signal reaches the shell rather than the whole process
tree the script spawned.

## Decision

**Mechanically:** start every script in its own process group and abort through a *second* exec
channel on the same connection, signalling the process group rather than the channel. Stage it:

1. `SIGINT` to the process group — what Ctrl-C would do, which is what the scripts' own
   confirmation prompts already expect;
2. after a grace period, `SIGTERM`;
3. after a second grace period, `SIGKILL`.

Each stage is a run event, so the audit trail shows how far the escalation went.

**By policy, gated on the script's criticality (ADR-004):**

| Criticality | Behaviour |
|---|---|
| read-only | Aborts immediately on request. No confirmation. |
| modifying | Requires an explicit confirmation naming the script, then aborts, and writes an audit entry recording who aborted what and at which stage it stopped. |
| unknown | Treated as modifying. An undeclared script is not a safe script. |

## Consequences

- The run reaches a terminal state of `aborted`, distinct from `failed`. The distinction matters
  for FA-10.2 (*last successful*) and for the audit trail.
- Result files written **before** the abort stay visible, for the same reason FA-09.5 exists: a
  partial result is evidence about what the run managed to do.
- The platform does **not** attempt to roll anything back. It cannot, and NFR-06 puts that
  squarely with the script owner. What it guarantees is that the abort is recorded precisely
  enough for a human to work out where the run stopped.
- The grace periods are configuration, not constants, because a script that is mid-write to a
  firewall deserves a different patience than one printing a table.
