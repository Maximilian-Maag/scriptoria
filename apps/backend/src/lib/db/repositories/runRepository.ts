import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type {
  AbortStage,
  Criticality,
  Run,
  RunEvent,
  RunFailureReason,
  RunListQuery,
  RunStatus,
} from "@scriptoria/contracts";
import { db, schema } from "../client";

const toRun = (row: schema.RunRow): Run => ({
  id: row.id,
  areaId: row.areaId,
  scriptId: row.scriptId,
  scriptFileName: row.scriptFileName,
  scriptTitle: row.scriptTitle,
  criticality: row.criticality,
  status: row.status,
  trigger: row.trigger,
  startedBy: row.startedBy,
  host: row.host,
  queuedAt: row.queuedAt.toISOString(),
  startedAt: row.startedAt?.toISOString() ?? null,
  finishedAt: row.finishedAt?.toISOString() ?? null,
  exitCode: row.exitCode,
  failureReason: (row.failureReason as RunFailureReason | null) ?? null,
  lastStreamId: row.lastStreamId,
  resultCount: row.resultCount,
});

export async function createRun(input: {
  areaId: string;
  scriptId: string;
  scriptFileName: string;
  scriptTitle: string;
  criticality: Criticality;
  host: string;
  outputPath: string;
  startedBy: string;
  trigger: "manual" | "scheduled";
  cols: number;
  rows: number;
}): Promise<Run> {
  const [row] = await db().insert(schema.runs).values(input).returning();
  await appendEvent(row!.id, "queued", "Accepted and queued");
  return toRun(row!);
}

export async function findRunById(id: string): Promise<schema.RunRow | null> {
  const row = await db().query.runs.findFirst({ where: eq(schema.runs.id, id) });
  return row ?? null;
}

export async function getRun(id: string): Promise<Run | null> {
  const row = await findRunById(id);
  return row ? toRun(row) : null;
}

export async function listRuns(
  areaIds: readonly string[],
  filter: RunListQuery,
): Promise<{ items: Run[]; total: number }> {
  if (areaIds.length === 0) return { items: [], total: 0 };

  const conditions: SQL[] = [
    // Scoped to the session's areas at the SQL level rather than filtered
    // afterwards, so a bug in a later `if` cannot widen the result set.
    inArray(schema.runs.areaId, [...areaIds]),
  ];
  if (filter.areaId) conditions.push(eq(schema.runs.areaId, filter.areaId));
  if (filter.scriptId) conditions.push(eq(schema.runs.scriptId, filter.scriptId));
  if (filter.status) conditions.push(eq(schema.runs.status, filter.status));

  const where = and(...conditions);

  const [rows, [counted]] = await Promise.all([
    db()
      .select()
      .from(schema.runs)
      .where(where)
      .orderBy(desc(schema.runs.queuedAt))
      .limit(filter.limit)
      .offset(filter.offset),
    db().select({ total: sql<number>`count(*)::int` }).from(schema.runs).where(where),
  ]);

  return { items: rows.map(toRun), total: counted?.total ?? 0 };
}

/**
 * The state machine's only writer. `from` guards the transition: a worker that
 * lost its lease and comes back cannot move a run that has already finished.
 */
export async function transition(
  id: string,
  to: RunStatus,
  patch: Partial<{
    workerId: string;
    startedAt: Date;
    finishedAt: Date;
    exitCode: number | null;
    failureReason: RunFailureReason | null;
    lastStreamId: string | null;
    abortStage: AbortStage | null;
    resultCount: number | null;
  }> = {},
  from?: readonly RunStatus[],
): Promise<boolean> {
  const guard = from
    ? and(eq(schema.runs.id, id), inArray(schema.runs.status, [...from]))
    : eq(schema.runs.id, id);

  const rows = await db()
    .update(schema.runs)
    .set({ status: to, ...patch })
    .where(guard)
    .returning({ id: schema.runs.id });

  return rows.length > 0;
}

export async function recordAbortRequest(
  id: string,
  requestedBy: string,
): Promise<void> {
  await db()
    .update(schema.runs)
    .set({ abortRequestedBy: requestedBy, abortRequestedAt: new Date() })
    .where(eq(schema.runs.id, id));
}

export async function appendEvent(
  runId: string,
  kind: schema.RunEventRow["kind"],
  message: string,
  stage: AbortStage | null = null,
): Promise<void> {
  await db().insert(schema.runEvents).values({ runId, kind, message, stage });
}

export async function listEvents(runId: string): Promise<RunEvent[]> {
  const rows = await db()
    .select()
    .from(schema.runEvents)
    .where(eq(schema.runEvents.runId, runId))
    .orderBy(schema.runEvents.at);

  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    at: row.at.toISOString(),
    kind: row.kind,
    stage: row.stage,
    message: row.message,
  }));
}

export async function saveTranscript(
  runId: string,
  contentBase64: string,
  sizeBytes: number,
  truncated: boolean,
): Promise<void> {
  await db()
    .insert(schema.runTranscripts)
    .values({ runId, content: contentBase64, sizeBytes, truncated })
    .onConflictDoUpdate({
      target: schema.runTranscripts.runId,
      set: { content: contentBase64, sizeBytes, truncated, persistedAt: new Date() },
    });
}

export async function getTranscript(runId: string) {
  const row = await db().query.runTranscripts.findFirst({
    where: eq(schema.runTranscripts.runId, runId),
  });
  return row ?? null;
}
