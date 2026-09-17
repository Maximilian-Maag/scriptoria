# ADR-008 — The audit log is the root account's, and reading it is not audited

**Status:** Proposed
**Context:** FA-12, FA-02.4, NFR-05

## Context

FA-12 is emphatic about what is *recorded* — every run, every download, every administrative
change — and silent about who may *read* it back. Until the log had a screen the question did
not arise, because reading it meant `psql` and therefore meant a database credential. Giving it
a screen forces the question.

The roles table is the only evidence in the requirements. An administrator's rights are the
areas, scripts, runs and results their groups reach (FA-02.4). Root's are creating areas,
mapping paths, entitling groups and maintaining recurring jobs. Neither list mentions reading
the log.

## Decision

`GET /api/admin/audit` is `requireRoot`, like everything else under `/api/admin`, and the
screen behind it is root's alone. The service is deliberately **unbounded** — it filters by
actor, action, area, run and time window, and by nothing derived from the caller.

Reading the log is not itself audited.

## Why not scope it to an administrator's own areas

It is the obvious alternative and it is worse than it looks. An audit log narrowed to the
reader's own entitlements is not an audit log: the entries that matter most in an
investigation are the ones about the area somebody should *not* have reached, and those are
precisely the entries such a filter removes. It would also leak sideways — an entry names its
actor, so an administrator of one area would learn who else in the organisation ran what,
which is not a right FA-02.4 gives them.

Half the log has no area at all. Every login, every failed login and every logout is recorded
with `areaId` null, so an area-scoped view would either drop them — and lose the whole access
record — or show them to everybody.

## Why reading is not audited

A read changes nothing, and recording every page of every search would bury the acts the log
exists for underneath the searches for them. The log is read during an investigation; an
investigation that doubles the size of the evidence while conducting it is a worse
investigation. NFR-05 asks for complete auditing of *runs*, which this does not weaken.

## Consequences

- An administrator who wants to know who ran what in their own area cannot find out from the
  platform. The run history (FA-05.4) answers most of that question within their entitlement,
  and this ADR is the reason the gap is deliberate rather than an oversight.
- If that turns out to be the wrong call, the change is bounded: `queryAuditLog` takes a filter
  and the route supplies it, so an area-scoped variant is a second caller rather than a
  redesign. The unbounded service would then need a comment saying who may reach it, because
  the route guard would no longer be the whole answer.
- The status here is **Proposed** rather than Accepted on purpose. Nothing in the requirements
  settles it, and it is a judgement about who is trusted with what — which belongs to whoever
  owns the platform rather than to whoever wrote the screen.
