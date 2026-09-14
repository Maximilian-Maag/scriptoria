import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Area, AreaSummary } from "@scriptoria/contracts";
import type { AreaEntitlement } from "@scriptoria/core";
import { db, schema } from "../client";

/**
 * The only module that speaks SQL about areas. Everything above it takes and
 * returns contract types, so a schema change stops here.
 */

const toIso = (value: Date) => value.toISOString();

export async function listEntitlements(): Promise<AreaEntitlement[]> {
  const rows = await db()
    .select({
      areaId: schema.areaEntitlements.areaId,
      directoryGroup: schema.areaEntitlements.directoryGroup,
    })
    .from(schema.areaEntitlements);
  return rows;
}

export async function listRootGroups(): Promise<string[]> {
  const rows = await db()
    .select({ directoryGroup: schema.rootGroups.directoryGroup })
    .from(schema.rootGroups);
  return rows.map((row) => row.directoryGroup);
}

/** The navigation's view: only the areas this session is entitled to. */
export async function listAreaSummaries(areaIds: readonly string[]): Promise<AreaSummary[]> {
  if (areaIds.length === 0) return [];
  const rows = await db()
    .select({
      id: schema.areas.id,
      name: schema.areas.name,
      description: schema.areas.description,
      category: schema.areas.category,
    })
    .from(schema.areas)
    .where(inArray(schema.areas.id, [...areaIds]))
    .orderBy(asc(schema.areas.name));
  return rows;
}

/** The admin's view: everything, with its mappings and entitlements. */
export async function listAreasWithDetail(): Promise<Area[]> {
  const rows = await db().query.areas.findMany({
    with: { sources: true, entitlements: true },
    orderBy: [asc(schema.areas.name)],
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    sources: row.sources.map((source) => ({
      id: source.id,
      host: source.host,
      port: source.port,
      username: source.username,
      scriptPath: source.scriptPath,
      outputPath: source.outputPath,
    })),
    entitlements: row.entitlements.map((entitlement) => ({
      id: entitlement.id,
      directoryGroup: entitlement.directoryGroup,
    })),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }));
}

export async function findAreaById(id: string): Promise<Area | null> {
  const row = await db().query.areas.findFirst({
    where: eq(schema.areas.id, id),
    with: { sources: true, entitlements: true },
  });
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    sources: row.sources.map((source) => ({
      id: source.id,
      host: source.host,
      port: source.port,
      username: source.username,
      scriptPath: source.scriptPath,
      outputPath: source.outputPath,
    })),
    entitlements: row.entitlements.map((entitlement) => ({
      id: entitlement.id,
      directoryGroup: entitlement.directoryGroup,
    })),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export async function createArea(input: {
  name: string;
  description: string;
  category: "one-off" | "recurring";
}): Promise<string> {
  const [row] = await db().insert(schema.areas).values(input).returning({ id: schema.areas.id });
  return row!.id;
}

export async function updateArea(
  id: string,
  input: Partial<{ name: string; description: string; category: "one-off" | "recurring" }>,
): Promise<boolean> {
  const rows = await db()
    .update(schema.areas)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(schema.areas.id, id))
    .returning({ id: schema.areas.id });
  return rows.length > 0;
}

export async function deleteArea(id: string): Promise<boolean> {
  const rows = await db()
    .delete(schema.areas)
    .where(eq(schema.areas.id, id))
    .returning({ id: schema.areas.id });
  return rows.length > 0;
}

export async function addSource(
  areaId: string,
  input: {
    host: string;
    port: number;
    username: string;
    scriptPath: string;
    outputPath: string;
  },
): Promise<string> {
  const [row] = await db()
    .insert(schema.scriptSources)
    .values({ areaId, ...input })
    .returning({ id: schema.scriptSources.id });
  return row!.id;
}

export async function removeSource(areaId: string, sourceId: string): Promise<boolean> {
  const rows = await db()
    .delete(schema.scriptSources)
    .where(and(eq(schema.scriptSources.areaId, areaId), eq(schema.scriptSources.id, sourceId)))
    .returning({ id: schema.scriptSources.id });
  return rows.length > 0;
}

export async function addEntitlement(areaId: string, directoryGroup: string): Promise<string> {
  // Mapping a group that is already mapped has got the caller what they wanted,
  // so this is idempotent rather than a conflict. The lookup is case-insensitive
  // because directories are; the unique index enforces the same rule, and it is
  // the index rather than this read that makes the invariant true under a race.
  const [existing] = await db()
    .select({ id: schema.areaEntitlements.id })
    .from(schema.areaEntitlements)
    .where(
      and(
        eq(schema.areaEntitlements.areaId, areaId),
        sql`lower(${schema.areaEntitlements.directoryGroup}) = lower(${directoryGroup})`,
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [row] = await db()
    .insert(schema.areaEntitlements)
    .values({ areaId, directoryGroup })
    .returning({ id: schema.areaEntitlements.id });
  return row!.id;
}

export async function removeEntitlement(areaId: string, entitlementId: string): Promise<boolean> {
  const rows = await db()
    .delete(schema.areaEntitlements)
    .where(
      and(
        eq(schema.areaEntitlements.areaId, areaId),
        eq(schema.areaEntitlements.id, entitlementId),
      ),
    )
    .returning({ id: schema.areaEntitlements.id });
  return rows.length > 0;
}

/** Every source of every area the session may see — what the scanner works from. */
export async function listSourcesForAreas(areaIds: readonly string[]) {
  if (areaIds.length === 0) return [];
  return db()
    .select()
    .from(schema.scriptSources)
    .where(inArray(schema.scriptSources.areaId, [...areaIds]));
}
