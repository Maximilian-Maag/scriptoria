# ADR-005 — The crontab stays authoritative; the platform runs no scheduler

**Status:** Accepted
**Context:** FA-10, NFR-16, open decision O-4

## Context

Recurring scripts have to be listed, their last successful run shown, and their schedules
editable without shell access (FA-10.4). The scripts already run as cronjobs on the script VM
today, and the external monitoring system watches them there.

## Decision

The crontab on each script VM stays the single source of truth. The platform reads it over
SSH, writes it back when the root account edits a schedule, and computes *next use* from the cron
expression with `cron-parser`. It runs no scheduler of its own.

## Why not a scheduler in the platform

Two schedulers is two truths. The failure mode is not hypothetical — it is jobs that run twice
or never, and it would arrive in exactly the estate where a double run means hundreds of sites
getting the same change applied twice. The monitoring system already hangs off the crontab; moving the
schedule into the platform would silently detach monitoring that is meant to stay (NFR-16).

## Consequences

- A schedule edited outside the platform is picked up automatically, because the platform reads
  rather than owns.
- Writing a crontab is a read-modify-write over SSH and needs to be done carefully: the platform
  touches only the lines it manages, marked with a generated block delimiter, and leaves
  everything else byte-for-byte intact.
- *Last successful* comes from the platform's own run records for platform-started runs, and
  from the script's output directory for cron-started ones — the platform does not see a cron
  run happen, only what it left behind. This is a real limitation and is why open decision O-1
  proposes reducing FA-10.2 to *last successful* rather than pretending to full run telemetry.
- Which crontab, and under which account, is still open (O-4). The reading here assumes the
  service account that owns the script directory.
