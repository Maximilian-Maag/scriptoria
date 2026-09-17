import { describe, expect, it } from "vitest";
import {
  canAccessArea,
  groupNameFromDn,
  isRoot,
  resolveAreaIds,
  sameAreaSet,
} from "../src/authorization";

const entitlements = [
  { areaId: "area-branch", directoryGroup: "scriptoria-branch-network" },
  { areaId: "area-firewall", directoryGroup: "scriptoria-firewall" },
  { areaId: "area-datacenter", directoryGroup: "scriptoria-datacenter" },
];

describe("groupNameFromDn", () => {
  it("takes the name out of a group DN", () => {
    expect(groupNameFromDn("cn=scriptoria-firewall,ou=groups,dc=scriptoria,dc=test")).toBe(
      "scriptoria-firewall",
    );
  });

  it("passes a bare group name through", () => {
    expect(groupNameFromDn("scriptoria-firewall")).toBe("scriptoria-firewall");
  });

  it("keeps an escaped comma that is part of the name", () => {
    expect(groupNameFromDn("cn=Network\\, West,ou=groups,dc=scriptoria,dc=test")).toBe(
      "Network, West",
    );
  });
});

describe("resolveAreaIds", () => {
  it("maps the groups the directory reported onto the areas that were mapped", () => {
    const areas = resolveAreaIds(
      [
        "cn=scriptoria-branch-network,ou=groups,dc=scriptoria,dc=test",
        "cn=scriptoria-firewall,ou=groups,dc=scriptoria,dc=test",
      ],
      entitlements,
    );
    expect(areas.sort()).toEqual(["area-branch", "area-firewall"]);
  });

  it("matches group names case-insensitively", () => {
    // A directory returns whatever case it feels like. Comparing raw is a bug
    // that shows up as an administrator mysteriously seeing nothing.
    expect(resolveAreaIds(["SCRIPTORIA-Firewall"], entitlements)).toEqual(["area-firewall"]);
  });

  it("returns an empty set for an account in no mapped group — a valid outcome", () => {
    // FA-01.4. admin.none exists in the directory fixture for exactly this case.
    expect(resolveAreaIds(["scriptoria-unmapped"], entitlements)).toEqual([]);
  });

  it("returns an empty set when no mapping exists at all", () => {
    // Without the root account's mapping the platform is functionless — and says
    // so by showing nothing, not by erroring.
    expect(resolveAreaIds(["scriptoria-firewall"], [])).toEqual([]);
  });

  it("does not duplicate an area entitled through two groups", () => {
    const areas = resolveAreaIds(
      ["scriptoria-firewall", "scriptoria-firewall-leads"],
      [
        { areaId: "area-firewall", directoryGroup: "scriptoria-firewall" },
        { areaId: "area-firewall", directoryGroup: "scriptoria-firewall-leads" },
      ],
    );
    expect(areas).toEqual(["area-firewall"]);
  });
});

describe("isRoot", () => {
  it("is true only for membership in a configured root group", () => {
    expect(
      isRoot(["cn=scriptoria-root,ou=groups,dc=scriptoria,dc=test"], ["scriptoria-root"]),
    ).toBe(true);
    expect(isRoot(["scriptoria-firewall"], ["scriptoria-root"])).toBe(false);
  });

  it("does not make an administrator root by having many areas", () => {
    // Root is a different job, not a bigger one. Entitlement to every area is
    // still not entitlement to change what the areas are.
    expect(
      isRoot(
        entitlements.map((e) => e.directoryGroup),
        ["scriptoria-root"],
      ),
    ).toBe(false);
  });
});

describe("canAccessArea", () => {
  it("answers from the session's area set and nothing else", () => {
    expect(canAccessArea(["area-firewall"], "area-firewall")).toBe(true);
    expect(canAccessArea(["area-firewall"], "area-datacenter")).toBe(false);
    expect(canAccessArea([], "area-firewall")).toBe(false);
  });
});

/**
 * FA-11's runtime half. The administrative sweep re-resolves every live session
 * after a mapping changes and rewrites only the ones that moved, so this
 * decides both what gets revoked promptly and whose idle window is left alone.
 */
describe("sameAreaSet", () => {
  it("ignores the order the ids arrive in", () => {
    expect(sameAreaSet(["area-branch", "area-firewall"], ["area-firewall", "area-branch"])).toBe(
      true,
    );
  });

  it("sees an area that was granted", () => {
    expect(sameAreaSet(["area-branch", "area-firewall"], ["area-branch"])).toBe(false);
  });

  it("sees an area that was revoked", () => {
    expect(sameAreaSet(["area-branch"], ["area-branch", "area-firewall"])).toBe(false);
  });

  it("sees a swap that leaves the count unchanged", () => {
    // The case a length comparison alone would miss: one area revoked and
    // another granted in the same edit. The session must still be rewritten.
    expect(sameAreaSet(["area-firewall"], ["area-branch"])).toBe(false);
  });

  it("calls two empty sets the same", () => {
    // FA-01.4's account, in no entitled group, across an edit that does not
    // concern it. Nothing changed, so nothing is written and its session's
    // idle window is not quietly extended.
    expect(sameAreaSet([], [])).toBe(true);
  });

  it("sees the first area an empty session gains", () => {
    expect(sameAreaSet(["area-branch"], [])).toBe(false);
  });
});
