# ADR-001 — Execute over outbound SSH with a PTY, not through a per-VM agent

**Status:** Accepted
**Context:** NFR-01, NFR-05, NFR-07, NFR-08, NFR-21

## Context

The control plane has to start Linux scripts on the script VM, which owns their runtime
environment, drive a PTY for the interactive ones, and fetch the result files afterwards. That
VM sits in a restricted segment, and its hardening and audit posture is the reason it is
trusted with onward access to the network devices, firewalls and hypervisors the scripts
manage.

## Options

**A — Outbound SSH with a PTY.** The control plane opens an outbound SSH connection, allocates
a PTY, starts the script in its service context (`bash ./script.sh`, or activating a venv and
running Python), streams stdin and stdout, signals to abort, and fetches the results over SFTP
on the same channel. The context must also tolerate scripts that bootstrap themselves — create
a user and group, directories, configuration files, a venv, and install packages (NFR-21).

*For:* no new software on the script VM, no additional listening ports, connections outbound
only, and an already hardened and audited protocol. The SFTP path exists today — the platform
only makes it invisible to the user, which is exactly what NFR-15 asks for.
*Against:* key management and the mapping of platform entitlements onto technical accounts have to be
worked out properly.

**B — A small agent per script VM,** speaking mTLS to the control plane.

*For:* finer control over the process lifecycle, resource limits and structured feedback.
*Against:* a new listening service on hardened systems, its own update and review path, and
additional attack surface in precisely the place where it is most expensive.

## Decision

Option A. Interactivity is fully expressible over SSH, and the security gain outweighs the
convenience of an agent.

## Consequences

- The runner is written against an `ExecutionTarget` interface. If option B is ever needed, it
  is a new implementation of that interface and nothing above it changes.
- Two SSH-specific problems have to be solved rather than assumed away, and they are:
  - an OpenSSH server commonly **ignores the SSH signal message**, so aborting through the
    channel does not reliably kill anything — see ADR-003;
  - a host key has to be pinned per script VM, because trust-on-first-use in an isolated zone is
    not trust.
- Key material lives only in the runner container, never in the frontend or the control plane.
