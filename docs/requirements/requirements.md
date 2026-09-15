# Requirements — Scriptoria

**Status:** MVP 1. There is no internal prioritisation: everything listed is a precondition
for the product being useful at all. The MVP is therefore indivisible as a scope, and the
build order in [§6](#6-build-order) exists for engineering reasons only.

Requirement IDs (`FA-xx`, `NFR-xx`) are referenced from the architecture model, the ADRs and
the source comments. They are stable — a requirement that goes away is struck through rather
than renumbered.

---

## 0. Product Vision

A web frontend through which teams select, start, interactively drive and collect the results
of **existing Linux scripts** that live on a script VM — **without Linux, shell or environment
knowledge, and without jump-server handwork**.

Scripts run generically on Linux: Bash and shell scripts as well as other languages, notably
Python, provided they are executable in their own service environment.

**Explicit boundary:** the platform is a *workaround for partial automation* on the way to
full automation. It only *presents* and *starts* scripts. Responsibility for the content and
the effect of a script stays with the script owner.

---

## 1. Roles

| Role | Origin | Rights and duties |
|---|---|---|
| **Administrator** | A directory account in at least one entitled group | Log in, see the entitled areas, select / start / stop scripts, interact with them, read the terminal, retrieve and download results |
| **Root account** | A directory account in a configured root group | Create areas, map filesystem paths onto them, entitle directory groups, maintain recurring jobs |
| **Script owner** | Not a platform role | Owns the content and the effect of the scripts, places them on the script VM, and does not use the platform |

Root is **not** a bigger administrator. It configures what administrators can reach, which is
a different job: an account entitled to every area still cannot change what the areas are.

**Not a role, but the central authorisation construct: the group.** A group here is a
*reference* to a directory group — no sync, no copy. Areas are entitled to groups. An account
may be in several. There is **no per-account entitlement anywhere in the product.**

---

## 2. Functional Requirements

### FA-01 Login

| ID | Requirement |
|---|---|
| FA-01.1 | An administrator logs into the system to reach the interface. |
| FA-01.2 | Authentication is by the credentials of a directory account. There is no SSO and no external identity provider. |
| FA-01.3 | On login the account is **assigned** the groups it holds in the directory, so that the areas released to those groups become usable. |
| FA-01.4 | Any directory account may authenticate successfully. An account without a matching group sees nothing. **An empty screen is a valid, expected outcome — not an error state**, and must not be rendered as one. |

> The wording of FA-01.3 matters. An earlier formulation — *"so that I receive my
> entitlement"* — is wrong, because the entitlement is **not** held in the system. It is only
> assigned to the session. FA-01.4 is the direct consequence.

### FA-02 Authorisation

| ID | Requirement |
|---|---|
| FA-02.1 | Authorisation is evaluated **exclusively** against groups, never against individual accounts. |
| FA-02.2 | Session entitlements are **discarded in full and rebuilt from the directory at every login**. Nothing is carried over from a previous session. |
| FA-02.3 | Directory groups are **referenced, never synchronised**. No local account or group inventory comes into existence. |
| FA-02.4 | An administrator sees only the areas, scripts, runs and results reachable through their groups. |

> This epic deliberately has no user-facing stories. It is entirely non-functional and lives
> in the authorisation service.

### FA-03 Area and Script Overview

| ID | Requirement |
|---|---|
| FA-03.1 | An administrator is shown an overview of the areas assigned to them. |
| FA-03.2 | An administrator navigates between areas to select scripts. |
| FA-03.3 | Per area, an administrator sees the scripts and jobs available to them. |
| FA-03.4 | An administrator sees a script's **header** in order to understand its use case before starting it. The script body is deliberately **not** part of the overview — real scripts run to thousands of lines. |
| FA-03.5 | An administrator can tell whether a script only **reads** or also **modifies** target systems, in order to judge the risk of running it. |
| FA-03.6 | The landing page after login is deliberately **empty**, with a left navigation bar listing the areas. Opening an area is an explicit click. Nothing else appears on the dashboard. |

> FA-03.5 is the requirement the abort design hangs off. Some scripts only read and are
> effectively harmless; others modify infrastructure, and a mistake there can leave hundreds
> of sites in a state nobody described. Safeguards *inside* the scripts — double confirmations
> — already exist. What the platform must add is making the criticality **visible before the
> start**, not after.

### FA-04 Script Selection

| ID | Requirement |
|---|---|
| FA-04.1 | An administrator selects a script in order to start it. Selection and start are **two separate steps**. |
| FA-04.2 | There is no version management. Two versions of a script are two separate scripts. |

### FA-05 Script Execution

| ID | Requirement |
|---|---|
| FA-05.1 | An administrator starts the selected script so that it runs in its correct environment. |
| FA-05.2 | A script is started **without entering parameters** when the parameter set is fixed in the code, so that no prior knowledge is required. |
| FA-05.3 | A script is started in a defined **service context**, so that scripts which first create directories, configuration files or their own environment also run. |
| FA-05.4 | A **non-interactive** script is started, its course recorded in full, and its result checked afterwards. |
| FA-05.5 | There is **no parametrisation before the start**. Either the parameter set is in the code, or parameters are requested through dialogue after the start (→ FA-06). |

> The majority of scripts have no interaction at all. Go there and do it.

### FA-06 Script Interaction

| ID | Requirement |
|---|---|
| FA-06.1 | An administrator interacts with a running script in order to answer parameters and dialogues. |
| FA-06.2 | Several dialogue steps are walked through iteratively — for example across many sites — in order to steer a run stepwise. |
| FA-06.3 | For interactive scripts the output is **part of the interaction**, not its end. The global output only appears at the very end. |

### FA-07 Terminal Output

| ID | Requirement |
|---|---|
| FA-07.1 | The live output of the script is shown, so its current state can be followed. |
| FA-07.2 | The **complete terminal history up to the end of the run** stays visible, so earlier output remains readable. |
| FA-07.3 | Terminal content can be selected and copied, to carry it straight into other systems. |
| FA-07.4 | A **status area above the terminal** shows the state of the run at a glance. |
| FA-07.5 | A terminal that stays empty is **not an error**. Many scripts deliberately produce little or no screen output. |

> **The vocabulary distinction that decides the architecture:**
> - **Terminal** — the live bidirectional input/output channel of the running process.
>   Everything that happens during the run, dialogues included, is terminal.
> - **Output / Result** — a **file written into a defined directory**, which must be
>   downloadable (→ FA-09).
>
> These are two channels with different lifecycles, and they are modelled separately.

### FA-08 Stopping a Script

| ID | Requirement |
|---|---|
| FA-08.1 | A running script can be aborted in order to stop it. |
| FA-08.2 | An interactive script is ended explicitly, because it runs as a loop and has no natural end. |
| FA-08.3 | Abort semantics differ by criticality: a read-only script aborts immediately; a **modifying** script requires confirmation and produces an audit entry. |

### FA-09 Result Provisioning

| ID | Requirement |
|---|---|
| FA-09.1 | An overview of results is shown, so a result's content can be opened. |
| FA-09.2 | Results are downloaded for further processing. |
| FA-09.3 | Many result files are downloaded together **as a ZIP**, rather than pulling hundreds of individual files. |
| FA-09.4 | Result content is copied, to transfer it to another system without a download. |
| FA-09.5 | The result is visible **even for a failed run**, in order to assess the failure. The exit code ends the run but does **not** decide result visibility. |
| FA-09.6 | Result files must be reachable **without jump-server and SFTP handwork**. Manual copying over a jump server is the state being abolished. |

> FA-09.3 is not theoretical: a single run can produce hundreds of files across dozens of
> sites, which is why the ZIP is the normal case rather than a convenience.
> FA-09.5 rests on a distinction worth keeping: *that it ran at all is an output* — an output
> may be positive or negative, a *result* is always positive.
> Scripts write both into their area's export directory (date-stamped, so runs can be
> compared) and into a shared global export directory.
> The term "result provisioning" is deliberate: download is only one of three forms —
> **display, copy, download**.

### FA-10 Recurring Scripts

| ID | Requirement |
|---|---|
| FA-10.1 | An overview of all recurring scripts is shown, to see which scripts run regularly. |
| FA-10.2 | *Last successful* is shown for a recurring script, to confirm successful execution. |
| FA-10.3 | A recurring script is run manually, to obtain its result immediately. |
| FA-10.4 | The root account maintains recurring jobs through the interface, to change schedules without shell access. |

> FA-10.2 was reduced to *last successful* deliberately. Run status is already monitored
> outside the platform, and the platform does not see a scheduled run happen — only what it
> left behind. Rebuilding failure alerting here would mean a second, worse copy of something
> that already works.

### FA-11 Area Administration

| ID | Requirement |
|---|---|
| FA-11.1 | The root account creates an area, to distinguish between the different services. |
| FA-11.2 | The root account grants an area access to a **filesystem path**, mapping the scripts there onto the area. |
| FA-11.3 | The root account entitles a **group** for an area, granting that group access. |
| FA-11.4 | The root account references a **directory group** onto an area, to model the entitlements. |
| FA-11.5 | The root account assigns an area to the category *one-off scripts* or *recurring scripts*, to structure the navigation. |

> **This is the entire justification for the root account.** The system is never authoritative
> for groups. Every session starts from reset; the system fetches the groups from the
> directory and matches them against the mapping the root account maintains locally. **Without
> that mapping the platform is functionless** — which is why FA-11 is built immediately after
> the walking skeleton.
>
> An area is a directory of scripts on the script VM plus the groups entitled to it. The
> simplest arrangement is one area per team or service, with the area name matching the
> directory group name.

### FA-12 Audit

| ID | Requirement |
|---|---|
| FA-12.1 | Every run is recorded in full: who started what, where, when, with which outcome, and what was aborted. |
| FA-12.2 | Every result download and every administrative change to areas, path mappings and group entitlements is audited. |

---

## 3. Non-Functional Requirements

In descending priority.

| ID | Requirement |
|---|---|
| NFR-01 | **Isolated environment.** The platform runs inside one private network per environment. The reverse proxy holds the only public address; the control plane, the runner, the data stores, the script VM and the directory are reachable only from within it. No external identity provider. Dependencies are vendored into the build rather than fetched at deploy time, so bringing an environment up does not depend on reaching a registry. |
| NFR-02 | Authentication against the **local directory over LDAP/LDAPS**. No SSO, no cloud identity provider. Login deliberately uses a separate account from everyday work. |
| NFR-03 | Authorisation **exclusively through groups**, never through individual accounts. Session entitlements are cleared and rebuilt at **every** login. The system is never authoritative for groups. |
| NFR-04 | Directory groups are **referenced, not synchronised**. No locally maintained account or group inventory. |
| NFR-05 | **Critical system.** The executed scripts have cross-access to core infrastructure — network devices, firewalls, virtualisation platforms, address management — across many sites. Hardening, complete auditing of every run, least privilege. |
| NFR-06 | Responsibility for the content and effect of a script lies with the **script owner**, not the platform. The platform only displays and starts scripts. |
| NFR-07 | The scripts run on a **script VM**, which owns their runtime environment — interpreters, virtual environments, credentials, output directories. The platform installs nothing there and assumes nothing about it. More than one script VM may exist, for example where two sets of scripts have incompatible dependencies; one is the normal case. |
| NFR-08 | **Bidirectional live streaming** of the terminal in real time (stdin/stdout/stderr) — the precondition for dialogue interaction. |
| NFR-09 | The **terminal buffer** must be large enough to hold the complete run up to script end. |
| NFR-10 | Typical runtimes 1 s to about 1 min; individual runs can take considerably longer. |
| NFR-11 | Web-based. Both web tiers are built on the same framework, so there is one build, one deployment shape and one set of conventions to learn. |
| NFR-12 | **Visual consistency.** The interface follows a documented set of design tokens rather than ad-hoc styling, so a later visual guideline is a token swap rather than a rewrite. |
| NFR-13 | Layout: **left navigation bar** (category → area → scripts/jobs), **status line at the top**, **terminal in the middle**, **output/download area to the right or below**. |
| NFR-14 | The layout must be **rebuildable at any time** — the first draft is deliberately a throwaway iteration, because a layout has to be seen before it can be judged. |
| NFR-15 | Result files must be reachable **without jump-server and SFTP handwork**. |
| NFR-16 | Monitoring of script runs happens in the **external monitoring system**, not in the platform. No own alerting. |
| NFR-17 | **No provable archival** of results required. |
| NFR-18 | **Tenant separation:** an administrator sees exclusively the areas, scripts and results assigned through their groups. |
| NFR-19 | Operating system base **Linux**. |
| NFR-20 | Initial volume: about a dozen productive scripts, several teams, growing. |
| NFR-21 | The execution environment must support scripts that **prepare their own local runtime context** — creating users and groups, directories, configuration files, a Python venv and installing packages. The platform must not assume all preconditions already exist in the service image. |
| NFR-22 | For non-interactive scripts the course must be recorded in full as a run, a terminal history and a result record, even though nobody interacts. |

---

## 4. Deliberately Out of Scope

| Topic | Reason |
|---|---|
| A "service owner" role in the platform | Entitlement happens in the directory, not in the tool |
| Per-account entitlement | Entitlement is a property of a group, never of a person |
| Sub-areas beneath an area | Handled by the script itself |
| Selecting a script version | Two versions are two scripts |
| Provable archival of results | Not required |
| Monitoring / alerting of runs | The external monitoring system already does this |
| SSO / cloud identity | Explicitly not wanted (NFR-02) |
| Full automation | The target picture *after* this platform |
| Reviewing or securing the scripts themselves | The script owner's responsibility (NFR-06) |

**Release 2 candidates** (raised, not committed): an in-app viewer for spreadsheet and PDF
results instead of a download; comparison of two result runs across date stamps; filtering
terminal output down to critical messages.

---

## 5. Open Decisions

These block nothing in the walking skeleton but must be closed before the corresponding
feature is built. Each one has a proposed answer.

| ID | Question | Proposal | Blocks |
|---|---|---|---|
| O-1 | Scope of the recurring-job metadata (FA-10.2) | Reduce to *last successful*; no failure alerting — the monitoring system owns that | FA-10 |
| O-2 | Abort semantics. What happens to a half-finished **modifying** script partway through hundreds of sites? | ADR-003: staged SIGINT → SIGTERM → SIGKILL, immediate for read-only scripts, confirmation plus audit entry for modifying ones | FA-08 |
| O-3 | No visual guideline document exists yet | Build against design tokens so a later guideline is a token swap, not a rewrite | FA-03 UI |
| O-4 | Which crontab, under which account, and does it stay authoritative? | The crontab on the script VM **stays authoritative**; the platform reads and writes it and never runs a second scheduler | FA-10 |
| O-5 | Retention of terminal logs and run history | Proposal: terminal log 90 days, run and audit records indefinite — they are small | FA-07, FA-12 |
| O-6 | A reference script and its setup documentation for the target environment | Precondition for pointing the walking skeleton at a real script VM. Until then it runs against the sshd fixture. | Walking skeleton |
| O-7 | How many concurrent runs per script VM are permitted? | Proposal: configurable per area, default 1, since the scripts were written for sequential manual use | FA-05 |
| O-8 | How is a script's read-only/modifying nature declared (FA-03.5)? | ADR-004: a structured header block in the script, with a stored override as fallback | FA-03 |

> O-8 is a gap in the requirements rather than a carried-over question. It is tempting to
> assume criticality is knowable; nothing in a script file states it, and it cannot be
> inferred reliably from the code. It has to be declared somewhere, by someone.

---

## 6. Build Order

The MVP is indivisible as a scope. This is the engineering sequence only.

1. **Walking skeleton** — directory login, one hard-wired area, a reference script, a live
   terminal stream, one download. Proves the four risky assumptions at once: the LDAPS bind,
   SSH/PTY interactivity, stream latency, and SFTP result access.
2. **Area administration and group mapping** (FA-11, FA-02, FA-03) — without this mapping the
   platform is functionless.
3. **Catalog, selection, execution, interaction, stopping** (FA-04 … FA-08).
4. **Result provisioning** in full, including ZIP (FA-09).
5. **Recurring scripts** (FA-10) — last, because the crontab ownership question sits here.

In parallel and early: the first UI draft as a deliberate throwaway iteration. The layout has
to be seen before it can be judged, and it must stay rebuildable (NFR-14).
