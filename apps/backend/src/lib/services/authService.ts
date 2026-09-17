import type { LoginRequest, SessionUser } from "@scriptoria/contracts";
import { isRoot, resolveAreaIds, sameAreaSet } from "@scriptoria/core";
import { authenticate } from "../auth/directory";
import {
  createSession,
  destroySession,
  readSession,
  scanSessions,
  updateSessionAreas,
  type Session,
} from "../auth/session";
import { areaRepository, auditRepository as audit } from "@scriptoria/db";
import { ok, type Result } from "../result";

/**
 * FA-01, FA-02, NFR-03.
 *
 * The sequence is the requirement, in order:
 *
 *   1. Bind as the user. Nothing else happens if this fails.
 *   2. Read their groups from AD.
 *   3. **Discard whatever entitlements existed and rebuild them from scratch**
 *      against the admin-maintained mapping.
 *
 * Step 3 is not an optimisation of step 2 — it is the reason the system can
 * claim never to be authoritative for groups. There is no merge, no diff and no
 * "keep what we had if AD is slow". A user whose groups AD no longer reports
 * loses the areas, in the same request.
 */

export async function login(
  request: LoginRequest,
  context: { sourceIp?: string | null },
): Promise<Result<{ session: Session; user: SessionUser }>> {
  const authenticated = await authenticate(request.username, request.password);

  if (!authenticated.ok) {
    await audit.record({
      actor: request.username,
      action: "login_failed",
      subject: request.username,
      outcome: "failure",
      detail: { code: authenticated.code },
      sourceIp: context.sourceIp ?? null,
    });
    return authenticated;
  }

  const directoryUser = authenticated.value;
  const [entitlements, rootGroups] = await Promise.all([
    areaRepository.listEntitlements(),
    areaRepository.listRootGroups(),
  ]);

  const areaIds = resolveAreaIds(directoryUser.groups, entitlements);
  const role = isRoot(directoryUser.groups, rootGroups) ? "root" : "administrator";

  const session = await createSession({
    username: directoryUser.username,
    displayName: directoryUser.displayName,
    role,
    groups: directoryUser.groups,
    areaIds,
  });

  await audit.record({
    actor: directoryUser.username,
    action: "login_succeeded",
    subject: directoryUser.username,
    // An empty area set is a valid outcome (FA-01.4), so this is recorded as a
    // successful login. It is still worth being able to find these entries: a
    // user who sees nothing will ask why, and this is the answer.
    detail: { role, groups: directoryUser.groups, areaCount: areaIds.length },
    sourceIp: context.sourceIp ?? null,
  });

  return ok({ session, user: toSessionUser(session) });
}

export async function logout(sessionId: string): Promise<Result<null>> {
  const session = await readSession(sessionId);
  if (session) {
    await destroySession(sessionId);
    await audit.record({ actor: session.username, action: "logout", subject: session.username });
  }
  return ok(null);
}

export function toSessionUser(session: Session): SessionUser {
  return {
    username: session.username,
    displayName: session.displayName,
    role: session.role,
    groups: session.groups,
    areaIds: session.areaIds,
    expiresAt: session.expiresAt.toISOString(),
  };
}

/**
 * NFR-03's runtime half. Called after an admin changes a mapping, so live
 * sessions lose an area without being logged out — which a self-contained token
 * could not do, and which is why the session store exists at all.
 *
 * Re-derived from the groups the session already holds rather than from a fresh
 * directory read: the groups are what AD said at login, and the *mapping* is
 * what changed.
 */
export async function refreshSessionEntitlements(session: Session): Promise<string[]> {
  const entitlements = await areaRepository.listEntitlements();
  const areaIds = resolveAreaIds(session.groups, entitlements);
  await updateSessionAreas(session.id, areaIds);
  return areaIds;
}

/**
 * The same thing across every live session, and what FA-11 calls after any
 * change to an area or its entitlements.
 *
 * Without this, revocation would be a promise the product does not keep: the
 * mapping would say one thing and every session opened before the edit would
 * go on seeing the area until its owner happened to sign in again. NFR-03 is
 * not a statement about logins, it is a statement about what the platform is
 * willing to show.
 *
 * Re-derived from the groups each session already holds, never from a fresh
 * directory read. The groups are what the directory said at that login and
 * stay that way until the next one (NFR-03); what changed here is the mapping.
 *
 * The mapping is read once for the whole sweep, so this is one query and one
 * write per session whose area set actually moved. Sessions that are
 * unaffected — the normal case, since most edits touch one area — are left
 * alone rather than rewritten, which also leaves their idle window intact.
 */
export async function refreshAllSessionEntitlements(): Promise<number> {
  const entitlements = await areaRepository.listEntitlements();
  const sessions = await scanSessions();

  let changed = 0;
  for (const { id, data } of sessions) {
    const areaIds = resolveAreaIds(data.groups, entitlements);
    if (sameAreaSet(areaIds, data.areaIds)) continue;
    await updateSessionAreas(id, areaIds);
    changed += 1;
  }
  return changed;
}
