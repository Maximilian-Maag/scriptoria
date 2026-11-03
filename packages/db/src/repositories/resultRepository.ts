import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { ResultFile } from "@scriptoria/contracts";
import { contentTypeFor, isPreviewable } from "@scriptoria/core";
import { db, schema } from "../client";

/**
 * FA-09. What the collector found in the output directory — a record of each
 * file, never the file. The files stay on the script VM and are streamed
 * through SFTP on request, which is what FA-09.6 asks for: no jump server, no
 * copy of the estate's data into this database.
 *
 * Written by the runner, read by the control plane.
 */

/** One file, as the collector listed it over SFTP. */
export interface CollectedFile {
  /** Relative to the run's output directory, so it survives the directory moving. */
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: Date;
}

const toResultFile = (row: schema.RunResultRow): ResultFile => ({
  path: row.path,
  name: row.name,
  sizeBytes: row.sizeBytes,
  modifiedAt: row.modifiedAt.toISOString(),
  contentType: row.contentType,
  previewable: isPreviewable(row.name, row.sizeBytes),
});

/**
 * Records one collection pass. Upserts rather than replaces: a run that is
 * still going gets collected more than once (FA-09.5's partial list), and a
 * file that grew between passes should show its new size rather than disappear
 * and come back.
 */
export async function recordResults(
  runId: string,
  files: readonly CollectedFile[],
): Promise<number> {
  if (files.length === 0) return 0;
  const now = new Date();

  await db()
    .insert(schema.runResults)
    .values(
      files.map((file) => ({
        runId,
        path: file.path,
        name: file.name,
        sizeBytes: file.sizeBytes,
        contentType: contentTypeFor(file.name),
        modifiedAt: file.modifiedAt,
        collectedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.runResults.runId, schema.runResults.path],
      set: {
        sizeBytes: sql`excluded.size_bytes`,
        modifiedAt: sql`excluded.modified_at`,
        collectedAt: now,
      },
    });

  return files.length;
}

export async function listResults(runId: string): Promise<ResultFile[]> {
  const rows = await db()
    .select()
    .from(schema.runResults)
    .where(eq(schema.runResults.runId, runId))
    .orderBy(asc(schema.runResults.path));
  return rows.map(toResultFile);
}

/**
 * The lookup a download performs. The path comes from a URL, so it is matched
 * against what the collector recorded rather than joined onto a directory: a
 * file the collector never saw is not downloadable, whatever the path says.
 */
export async function findResult(runId: string, path: string) {
  const [row] = await db()
    .select()
    .from(schema.runResults)
    .where(and(eq(schema.runResults.runId, runId), eq(schema.runResults.path, path)))
    .limit(1);
  return row ?? null;
}

/**
 * When this run's results were last looked at. Ordered rather than aggregated,
 * for the same reason as `lastScannedAt`: drizzle hands a raw `max()` back as
 * the driver's string, and this says it returns a Date.
 */
export async function collectedAt(runId: string): Promise<Date | null> {
  const [row] = await db()
    .select({ at: schema.runResults.collectedAt })
    .from(schema.runResults)
    .where(eq(schema.runResults.runId, runId))
    .orderBy(desc(schema.runResults.collectedAt))
    .limit(1);
  return row?.at ?? null;
}
