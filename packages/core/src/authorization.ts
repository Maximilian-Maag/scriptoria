/**
 * NFR-03, NFR-04, FA-02. The one rule the platform must never get creative with:
 * **the system is never authoritative for groups.**
 *
 * There is no user table, no group inventory, no per-user entitlement. A login
 * discards whatever the session held and rebuilds the area set from the groups
 * AD just reported, matched against the mapping an admin maintains locally.
 * Everything in this module is pure so that the rule can be read and tested
 * without a directory or a database anywhere near it.
 */

export interface AreaEntitlement {
  areaId: string;
  /** The directory group the root account mapped onto this area (FA-11.4). */
  directoryGroup: string;
}

/**
 * AD group names are not case-sensitive and arrive in whatever case the
 * directory feels like. Comparing them raw is a bug that shows up as a user
 * mysteriously seeing nothing.
 */
const normalise = (group: string) => group.trim().toLowerCase();

/**
 * Extracts the group's name from whatever AD handed back — a bare name, or a
 * full DN as `memberOf` returns it. Only the leading RDN value is the name.
 */
export function groupNameFromDn(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("cn=")) return trimmed;
  // Split on the first unescaped comma; an escaped one is part of the name.
  const match = /^cn=((?:[^,\\]|\\.)*)/i.exec(trimmed);
  return (match?.[1] ?? trimmed).replace(/\\(.)/g, "$1").trim();
}

/**
 * The area set for a session. An empty result is a valid outcome and not an
 * error (FA-01.4) — a user in no mapped group lands on an empty screen.
 */
export function resolveAreaIds(
  groups: readonly string[],
  entitlements: readonly AreaEntitlement[],
): string[] {
  const held = new Set(groups.map((g) => normalise(groupNameFromDn(g))));
  const areaIds = new Set<string>();
  for (const entitlement of entitlements) {
    if (held.has(normalise(entitlement.directoryGroup))) areaIds.add(entitlement.areaId);
  }
  return [...areaIds];
}

/**
 * Membership in one of the configured root groups, and nothing else.
 *
 * The root account is a directory group like any other, deliberately: making it
 * a local flag would mean the platform holds an identity fact of its own, and
 * the whole point of this module is that it never does.
 */
export function isRoot(groups: readonly string[], rootGroups: readonly string[]): boolean {
  const held = new Set(groups.map((g) => normalise(groupNameFromDn(g))));
  return rootGroups.some((g) => held.has(normalise(g)));
}

/**
 * The check every run, result and schedule route performs before it touches
 * anything. It takes the session's area set rather than the session, because a
 * function that cannot see a session cannot be talked into trusting one.
 */
export function canAccessArea(sessionAreaIds: readonly string[], areaId: string): boolean {
  return sessionAreaIds.includes(areaId);
}
