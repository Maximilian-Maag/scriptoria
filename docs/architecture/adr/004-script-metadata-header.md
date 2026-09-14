# ADR-004 — A script declares its own metadata in a header block

**Status:** Proposed · closes open decision O-8, needs the script owner's agreement
**Context:** FA-03.4, FA-03.5, FA-05.3

## Context

Two requirements need to know something about a script before it runs. FA-03.4 wants its header
shown so the user understands the use case; the scripts already carry an explanatory header, so
this part exists. FA-03.5 wants the user to see **whether the script only reads or also
modifies target systems** — and nothing in a script file states that today.

It cannot be inferred. A 3000-line Python script that writes to hundreds of sites and one that
reads from them look identical to a parser. Guessing here fails in the one direction that matters.

## Decision

A script declares its own metadata in a structured block inside its existing header comment,
read by the scanner from the first 100 lines and never from the body:

```bash
#!/usr/bin/env bash
# scriptoria:title        Interface inventory across all sites
# scriptoria:description  Reads the interface configuration of every device in the
#                         branch network and writes one workbook per site.
# scriptoria:criticality  read-only          # read-only | modifying
# scriptoria:interactive  false              # does the script prompt on stdin
# scriptoria:outputs      /opt/scriptoria/export    # where results land
```

Keys are optional and the parser is lenient — an unreadable or absent block must never keep a
script out of the catalog, only mark it undeclared.

**Fallback and override:** criticality can be set on a script in the platform. A stored
override wins over the header, so a script owner who has not yet annotated their scripts does
not block the rollout, and a wrong declaration can be corrected without editing a production
script.

**Default when nothing declares it:** `modifying`. An undeclared script is shown as such and
carries the confirmation from ADR-003. The safe default is the pessimistic one — the cost of
wrongly warning about a read-only script is an extra click, and the cost of the reverse is in
an unannounced change to every system the script touches.

## Consequences

- The script owner has a small amount of work: annotating the existing scripts. The fallback
  exists so that this is not on the critical path.
- Adding a metadata key later is backward compatible — old scripts simply do not have it.
- The scanner reads headers over SFTP and caches the result. A changed header is picked up on
  the next catalog refresh, not instantly; the catalog is not a filesystem watcher.
- This is the one place where the platform asks something of the scripts. It is worth being
  deliberate about keeping it the only one.
