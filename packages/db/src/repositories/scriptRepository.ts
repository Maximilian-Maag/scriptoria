import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Criticality, Script, ScriptHeader } from "@scriptoria/contracts";
import { effectiveCriticality } from "@scriptoria/core";
import { db, schema } from "../client";

/**
 * ADR-004's cache. The script VM's filesystem is the truth; these rows are what
 * the scanner last read from it, so a catalog page renders without an SSH round
 * trip per request.
 *
 * Nothing here deletes a script. A file that disappeared from the directory
 * keeps its row and stops being `present`, because runs reference it and FA-12
 * wants that history to stay readable.
 */

/** One file, as the scanner read it off the script VM. */
export interface ScannedScript {
  fileName: string;
  absolutePath: string;
  header: ScriptHeader | null;
  sizeBytes: number;
  modifiedAt: Date | null;
}

export function toScript(
  row: schema.ScriptRow,
  sourceOutputPath: string | null,
): Script {
  const header = row.header;
  const criticality = effectiveCriticality(row.criticalityOverride, header);

  return {
    id: row.id,
    areaId: row.areaId,
    sourceId: row.sourceId,
    fileName: row.fileName,
    absolutePath: row.absolutePath,
    // FA-03.4: the header is what an administrator reads before starting a
    // script. When it declares no title, the file name is the honest fallback —
    // inventing one from the path would be the platform describing a script it
    // has never looked inside.
    title: header?.title ?? row.fileName,
    description: header?.description ?? "",
    criticality,
    criticalityOverridden: row.criticalityOverride !== null,
    interactive: header?.interactive ?? false,
    outputPath: header?.outputs ?? sourceOutputPath,
    header,
    sizeBytes: row.sizeBytes,
    modifiedAt: row.modifiedAt?.toISOString() ?? null,
    scannedAt: row.scannedAt.toISOString(),
  };
}

/**
 * Writes what one scan of one source found.
 *
 * `presentAt` is bumped for everything the scan saw and left alone for
 * everything it did not, which is what makes a vanished script visible as
 * vanished rather than as missing.
 */
export async function replaceSourceScripts(
  areaId: string,
  sourceId: string,
  scanned: readonly ScannedScript[],
): Promise<void> {
  const now = new Date();

  if (scanned.length > 0) {
    await db()
      .insert(schema.scripts)
      .values(
        scanned.map((script) => ({
          areaId,
          sourceId,
          fileName: script.fileName,
          absolutePath: script.absolutePath,
          header: script.header,
          sizeBytes: script.sizeBytes,
          modifiedAt: script.modifiedAt,
          scannedAt: now,
          presentAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.scripts.sourceId, schema.scripts.fileName],
        set: {
          absolutePath: sql`excluded.absolute_path`,
          header: sql`excluded.header`,
          sizeBytes: sql`excluded.size_bytes`,
          modifiedAt: sql`excluded.modified_at`,
          scannedAt: now,
          presentAt: now,
          // The override is deliberately not in this list. An admin's correction
          // survives a rescan; it is a correction of the script's declaration,
          // not a copy of it.
        },
      });
  }

  const seen = scanned.map((script) => script.fileName);
  await db()
    .update(schema.scripts)
    .set({ scannedAt: now })
    .where(
      seen.length > 0
        ? and(eq(schema.scripts.sourceId, sourceId), notInArray(schema.scripts.fileName, seen))
        : eq(schema.scripts.sourceId, sourceId),
    );
}

/** The catalog of one area (FA-03.3), newest scan included. */
export async function listScriptsForArea(areaId: string): Promise<Script[]> {
  const rows = await db()
    .select({ script: schema.scripts, outputPath: schema.scriptSources.outputPath })
    .from(schema.scripts)
    .innerJoin(schema.scriptSources, eq(schema.scripts.sourceId, schema.scriptSources.id))
    .where(eq(schema.scripts.areaId, areaId))
    .orderBy(asc(schema.scripts.fileName));

  return rows.map((row) => toScript(row.script, row.outputPath));
}

/**
 * The oldest scan in this area — the one that decides whether the catalog is
 * stale, because an area is only as fresh as its least recently read source.
 *
 * Ordered rather than aggregated: a raw `min()` comes back as the driver's
 * string, and a function that says it returns a Date has to return one.
 */
export async function lastScannedAt(areaId: string): Promise<Date | null> {
  const [row] = await db()
    .select({ scannedAt: schema.scripts.scannedAt })
    .from(schema.scripts)
    .where(eq(schema.scripts.areaId, areaId))
    .orderBy(asc(schema.scripts.scannedAt))
    .limit(1);
  return row?.scannedAt ?? null;
}

/**
 * A script plus the source it came from — the shape a run start needs, because
 * starting one means knowing which host to reach and as whom.
 */
export async function findScriptWithSource(id: string) {
  const [row] = await db()
    .select({ script: schema.scripts, source: schema.scriptSources })
    .from(schema.scripts)
    .innerJoin(schema.scriptSources, eq(schema.scripts.sourceId, schema.scriptSources.id))
    .where(eq(schema.scripts.id, id))
    .limit(1);
  return row ?? null;
}

export async function setCriticalityOverride(
  id: string,
  criticality: Criticality | null,
  reason: string | null,
): Promise<boolean> {
  const rows = await db()
    .update(schema.scripts)
    .set({ criticalityOverride: criticality, criticalityOverrideReason: reason })
    .where(eq(schema.scripts.id, id))
    .returning({ id: schema.scripts.id });
  return rows.length > 0;
}

/** Scoped to the session's areas at the SQL level, never filtered afterwards. */
export async function findScriptInAreas(id: string, areaIds: readonly string[]) {
  if (areaIds.length === 0) return null;
  const [row] = await db()
    .select({ script: schema.scripts, source: schema.scriptSources })
    .from(schema.scripts)
    .innerJoin(schema.scriptSources, eq(schema.scripts.sourceId, schema.scriptSources.id))
    .where(and(eq(schema.scripts.id, id), inArray(schema.scripts.areaId, [...areaIds])))
    .limit(1);
  return row ?? null;
}
