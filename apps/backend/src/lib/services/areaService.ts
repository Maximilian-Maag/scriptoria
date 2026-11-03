import type {
  Area,
  AreaSummary,
  CreateAreaRequest,
  CreateGroupEntitlementRequest,
  CreateScriptSourceRequest,
  UpdateAreaRequest,
} from "@scriptoria/contracts";
import {
  areaRepository,
  auditRepository as audit,
  isForeignKeyViolation,
  isUniqueViolation,
} from "@scriptoria/db";
import type { Session } from "../auth/session";
import { refreshAllSessionEntitlements } from "./authService";
import { conflict, internal, notFound, ok, type Result } from "../result";

/**
 * FA-03's read for administrators, and all of FA-11 for the root account.
 *
 * The two halves answer different questions and are deliberately not the same
 * function. An administrator asks *what may I reach*, and the answer is bounded
 * by their session. The root account asks *what exists*, and the answer is not
 * bounded at all — that asymmetry is the whole content of the role split, so it
 * is visible here rather than hidden behind a flag.
 *
 * Every mutation in this module does three things in the same order: change the
 * mapping, record it (FA-12.2), then re-entitle the live sessions (NFR-03).
 */

/** Where FA-12.1's "where" comes from, carried down from the route. */
export interface AdminContext {
  sourceIp?: string | null;
}

// ── The administrator's read ─────────────────────────────────────────────────

/**
 * FA-03.1 and FA-03.6 — what the left navigation renders.
 *
 * The session's area set is the *only* input. It was built at login from the
 * groups the directory reported, matched against the mapping the root account
 * maintains (NFR-03), and nothing here widens it.
 *
 * An empty list is a valid answer and is returned as one: FA-01.4 is explicit
 * that an account in no entitled group sees nothing, and that this is an
 * outcome rather than an error. There is no 403 to return here — the user is
 * perfectly entitled to the nothing they can see.
 */
export async function listAreas(session: Session): Promise<Result<AreaSummary[]>> {
  return ok(await areaRepository.listAreaSummaries(session.areaIds));
}

// ── The root account's administration (FA-11) ────────────────────────────────

/**
 * Every area, with its path mappings and group entitlements.
 *
 * Unfiltered by design. The root account configures what administrators can
 * reach, and it cannot do that job through a view of what it happens to be
 * entitled to itself — an area nobody is entitled to yet is exactly the area
 * that needs administering. The route's `requireRoot` is what makes this safe;
 * this function takes no session because it has no use for one.
 */
export async function listAllAreas(): Promise<Result<Area[]>> {
  return ok(await areaRepository.listAreasWithDetail());
}

export async function getArea(areaId: string): Promise<Result<Area>> {
  const area = await areaRepository.findAreaById(areaId);
  if (!area) return notFound("No such area");
  return ok(area);
}

/** FA-11.1 and FA-11.5 — an area exists, and it is one-off or recurring. */
export async function createArea(
  session: Session,
  input: CreateAreaRequest,
  context: AdminContext = {},
): Promise<Result<Area>> {
  let areaId: string;
  try {
    areaId = await areaRepository.createArea({
      name: input.name,
      description: input.description ?? "",
      category: input.category,
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      return conflict(`An area called “${input.name}” already exists`);
    }
    return internal("Could not create the area", cause);
  }

  await audit.record({
    actor: session.username,
    action: "area_created",
    subject: input.name,
    areaId,
    detail: { category: input.category },
    sourceIp: context.sourceIp ?? null,
  });

  // A new area entitles nobody yet, so no live session can be affected. The
  // sweep is skipped rather than run for form's sake.
  return getArea(areaId);
}

export async function updateArea(
  session: Session,
  areaId: string,
  input: UpdateAreaRequest,
  context: AdminContext = {},
): Promise<Result<Area>> {
  const existing = await areaRepository.findAreaById(areaId);
  if (!existing) return notFound("No such area");

  // Only the fields the request actually carried. A PATCH that omits a field
  // is saying nothing about it, which is not the same as setting it to
  // undefined — and with `exactOptionalPropertyTypes` the compiler agrees.
  const patch: Parameters<typeof areaRepository.updateArea>[1] = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.category !== undefined) patch.category = input.category;

  if (Object.keys(patch).length === 0) return getArea(areaId);

  let updated: boolean;
  try {
    updated = await areaRepository.updateArea(areaId, patch);
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      return conflict(`An area called “${input.name}” already exists`);
    }
    return internal("Could not update the area", cause);
  }
  if (!updated) return notFound("No such area");

  await audit.record({
    actor: session.username,
    action: "area_updated",
    subject: existing.name,
    areaId,
    // Both sides, because "what did it used to say" is the first question
    // anybody reading this log will have.
    detail: { before: describe(existing), after: patch },
    sourceIp: context.sourceIp ?? null,
  });

  return getArea(areaId);
}

/**
 * FA-11.1's other half.
 *
 * The area's sources and entitlements go with it — they describe this area and
 * nothing else, and the schema cascades them. Runs do not: `runs.area_id` is
 * `on delete restrict`, so an area that anything was ever started in cannot be
 * deleted at all. That is FA-12.1 being load-bearing rather than decorative —
 * history that can be erased by tidying up the configuration is not an audit
 * trail. The conflict this produces is reported as one.
 */
export async function deleteArea(
  session: Session,
  areaId: string,
  context: AdminContext = {},
): Promise<Result<null>> {
  const existing = await areaRepository.findAreaById(areaId);
  if (!existing) return notFound("No such area");

  let deleted: boolean;
  try {
    deleted = await areaRepository.deleteArea(areaId);
  } catch (cause) {
    if (isForeignKeyViolation(cause)) {
      return conflict(
        `“${existing.name}” has runs recorded against it and cannot be deleted. ` +
          "Revoke its group entitlements instead — that removes it from everyone's " +
          "navigation and leaves the run history readable.",
      );
    }
    // Anything else is the database being unwell, and saying "it has runs" here
    // would send an administrator looking for a problem that does not exist.
    return internal("Could not delete the area", cause);
  }
  if (!deleted) return notFound("No such area");

  await audit.record({
    actor: session.username,
    action: "area_deleted",
    subject: existing.name,
    // Deliberately null rather than `areaId`: the row is gone and the audit
    // log's foreign key would have nulled it anyway. The name in `subject` is
    // what makes the entry readable, which is why it is a name and not an id.
    areaId: null,
    detail: { areaId, ...describe(existing) },
    sourceIp: context.sourceIp ?? null,
  });

  await refreshAllSessionEntitlements();
  return ok(null);
}

/** FA-11.2 — the filesystem path whose scripts belong to this area. */
export async function addSource(
  session: Session,
  areaId: string,
  input: CreateScriptSourceRequest,
  context: AdminContext = {},
): Promise<Result<Area>> {
  const existing = await areaRepository.findAreaById(areaId);
  if (!existing) return notFound("No such area");

  try {
    await areaRepository.addSource(areaId, input);
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      return conflict(`${input.scriptPath} on ${input.host} is already mapped to this area`);
    }
    return internal("Could not map the path", cause);
  }

  await audit.record({
    actor: session.username,
    action: "source_added",
    subject: `${input.host}:${input.scriptPath}`,
    areaId,
    detail: {
      area: existing.name,
      host: input.host,
      port: input.port,
      username: input.username,
      scriptPath: input.scriptPath,
      outputPath: input.outputPath,
    },
    sourceIp: context.sourceIp ?? null,
  });

  // A path mapping changes which scripts an area holds, not who may see the
  // area. No session's entitlements moved, so there is nothing to sweep.
  return getArea(areaId);
}

export async function removeSource(
  session: Session,
  areaId: string,
  sourceId: string,
  context: AdminContext = {},
): Promise<Result<Area>> {
  const existing = await areaRepository.findAreaById(areaId);
  if (!existing) return notFound("No such area");

  const source = existing.sources.find((candidate) => candidate.id === sourceId);
  if (!source) return notFound("No such path mapping on this area");

  const removed = await areaRepository.removeSource(areaId, sourceId);
  if (!removed) return notFound("No such path mapping on this area");

  await audit.record({
    actor: session.username,
    action: "source_removed",
    subject: `${source.host}:${source.scriptPath}`,
    areaId,
    detail: { area: existing.name, host: source.host, scriptPath: source.scriptPath },
    sourceIp: context.sourceIp ?? null,
  });

  return getArea(areaId);
}

/**
 * FA-11.3 and FA-11.4 — a directory group is entitled to an area.
 *
 * The group is *referenced by name*, and that is the entire mechanism (NFR-04).
 * Nothing here asks the directory whether the group exists, and nothing stores
 * who is in it. A name that matches nothing entitles nobody, which is a
 * harmless and self-correcting state: the group gets created later and the
 * mapping starts working, with no action here.
 */
export async function grantEntitlement(
  session: Session,
  areaId: string,
  input: CreateGroupEntitlementRequest,
  context: AdminContext = {},
): Promise<Result<Area>> {
  const existing = await areaRepository.findAreaById(areaId);
  if (!existing) return notFound("No such area");

  try {
    await areaRepository.addEntitlement(areaId, input.directoryGroup);
  } catch (cause) {
    return internal("Could not grant the entitlement", cause);
  }

  await audit.record({
    actor: session.username,
    action: "entitlement_granted",
    subject: input.directoryGroup,
    areaId,
    detail: { area: existing.name, directoryGroup: input.directoryGroup },
    sourceIp: context.sourceIp ?? null,
  });

  await refreshAllSessionEntitlements();
  return getArea(areaId);
}

/**
 * The revocation NFR-03 exists for. The sweep afterwards is not housekeeping:
 * it is the difference between a mapping the platform honours now and one it
 * honours the next time somebody happens to sign in.
 */
export async function revokeEntitlement(
  session: Session,
  areaId: string,
  entitlementId: string,
  context: AdminContext = {},
): Promise<Result<Area>> {
  const existing = await areaRepository.findAreaById(areaId);
  if (!existing) return notFound("No such area");

  const entitlement = existing.entitlements.find((candidate) => candidate.id === entitlementId);
  if (!entitlement) return notFound("No such entitlement on this area");

  const removed = await areaRepository.removeEntitlement(areaId, entitlementId);
  if (!removed) return notFound("No such entitlement on this area");

  await audit.record({
    actor: session.username,
    action: "entitlement_revoked",
    subject: entitlement.directoryGroup,
    areaId,
    detail: { area: existing.name, directoryGroup: entitlement.directoryGroup },
    sourceIp: context.sourceIp ?? null,
  });

  await refreshAllSessionEntitlements();
  return getArea(areaId);
}

/** What an area was, flattened for an audit entry. */
const describe = (area: Area) => ({
  name: area.name,
  description: area.description,
  category: area.category,
});
