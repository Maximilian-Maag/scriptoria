import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { chooseAdmissions } from "@scriptoria/core";
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
  collectedAt: row.collectedAt?.toISOString() ?? null,
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
    db()
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(where),
  ]);

  return { items: rows.map(toRun), total: counted?.total ?? 0 };
}

/**
 * FA-10.2 — *last successful* per script, for the recurring-scripts overview.
 *
 * Reduced to "last successful" on purpose (O-1). The platform does not see a
 * cron-started run happen — ADR-005 keeps the crontab authoritative and runs no
 * scheduler — so this answers only for runs the platform itself started.
 * Rebuilding failure telemetry here would be a second, worse copy of the
 * monitoring that already watches the crontab (NFR-16).
 *
 * One grouped query rather than one per schedule: a script VM's crontab can
 * hold dozens of lines and this renders a single page.
 */
export async function lastSuccessfulByScript(
  scriptIds: readonly string[],
): Promise<Map<string, Date>> {
  if (scriptIds.length === 0) return new Map();

  const rows = await db()
    .select({
      scriptId: schema.runs.scriptId,
      at: sql<Date>`max(${schema.runs.finishedAt})`,
    })
    .from(schema.runs)
    .where(and(inArray(schema.runs.scriptId, [...scriptIds]), eq(schema.runs.status, "succeeded")))
    .groupBy(schema.runs.scriptId);

  return new Map(
    rows.filter((row) => row.at !== null).map((row) => [row.scriptId, new Date(row.at)]),
  );
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
    collectedAt: Date;
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

export async function recordAbortRequest(id: string, requestedBy: string): Promise<void> {
  await db()
    .update(schema.runs)
    .set({ abortRequestedBy: requestedBy, abortRequestedAt: new Date() })
    .where(eq(schema.runs.id, id));
}

/**
 * The collection is over and this is what it found — the collector's write.
 *
 * `collectedAt` is what a view polls on and `resultCount` is what it displays,
 * so they are written together: a collection that ended has both, and one that
 * ended by failing has neither of these (see `markCollectionEnded`).
 */
export async function markCollected(id: string, count: number): Promise<void> {
  await db()
    .update(schema.runs)
    .set({ collectedAt: new Date(), resultCount: count })
    .where(eq(schema.runs.id, id));
}

/**
 * Nothing is going to be collected for this run — the platform's write, for the
 * ends nobody collects.
 *
 * A run cancelled before a worker claimed it, one whose start failed, one whose
 * worker is gone. It touches `collectedAt` alone, and that is the point: it
 * cannot then overwrite a count a collection has already recorded, and "nothing
 * will be collected" is not the same claim as "it collected nothing".
 */
export async function markCollectionEnded(id: string): Promise<void> {
  await db()
    .update(schema.runs)
    .set({ collectedAt: new Date() })
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

/**
 * O-5 / ADR-014 — drop the bytes of transcripts past their retention window.
 *
 * The row stays, with `pruned_at` set and no content: the console has to be able to
 * say "this was pruned" rather than showing an empty terminal that reads as a script
 * that printed nothing (FA-07.5). So this is an UPDATE, never a DELETE, and it is
 * idempotent — a second pass matches nothing because `pruned_at` is no longer null.
 *
 * Batched, because the alternative is one statement holding a lock over every old
 * transcript in the table, and the sweep runs on a timer: `batch` rows per pass,
 * oldest first, and the next pass continues.
 */
export async function pruneTranscriptsBefore(cutoff: Date, batch: number): Promise<number> {
  if (batch < 1) return 0;

  const rows = await db()
    .update(schema.runTranscripts)
    .set({ content: "", prunedAt: new Date() })
    .where(
      inArray(
        schema.runTranscripts.runId,
        db()
          .select({ runId: schema.runTranscripts.runId })
          .from(schema.runTranscripts)
          .where(
            and(
              isNull(schema.runTranscripts.prunedAt),
              lt(schema.runTranscripts.persistedAt, cutoff),
            ),
          )
          .orderBy(asc(schema.runTranscripts.persistedAt))
          .limit(batch),
      ),
    )
    .returning({ runId: schema.runTranscripts.runId });

  return rows.length;
}

// ── Dispatch (O-7, ADR-013) ──────────────────────────────────────────────────

export interface AdmittedRun {
  id: string;
  host: string;
  queuedAt: Date;
}

/**
 * O-7 — release runs that were dispatched and never claimed.
 *
 * A dispatched run occupies its script VM until a worker claims it, which is what
 * keeps the next sweep from admitting a second run into the same directory. The
 * cost of that is a mark that can outlive its job: a control plane that died
 * between the push and the claim, or a queue that lost the entry. Left alone,
 * such a run would hold its VM for ever, so the mark is cleared once it is older
 * than any plausible claim, and the next sweep dispatches the run again. A second
 * job for a run is harmless: the runner's claim is `SET NX`, so the duplicate is
 * discarded rather than opening a second PTY.
 */
export async function releaseStaleDispatches(staleSeconds: number): Promise<string[]> {
  if (staleSeconds < 1) return [];

  const rows = await db()
    .update(schema.runs)
    .set({ dispatchedAt: null })
    .where(
      and(
        eq(schema.runs.status, "queued"),
        isNotNull(schema.runs.dispatchedAt),
        lt(schema.runs.dispatchedAt, sql`now() - (${staleSeconds} * interval '1 second')`),
      ),
    )
    .returning({ id: schema.runs.id });

  return rows.map((row) => row.id);
}

/**
 * The runs a script VM is carrying, by id, so dispatch can ask whether the worker
 * behind one of them still exists (ADR-011's claim is the evidence, and it lives
 * in Redis, so the check is not a join).
 */
export async function listActiveByHost(): Promise<Array<{ id: string; host: string }>> {
  return db()
    .select({ id: schema.runs.id, host: schema.runs.host })
    .from(schema.runs)
    .where(inArray(schema.runs.status, ["starting", "running"]));
}

/** Whether anything is waiting at all, so an idle platform does no work. */
export async function countQueued(): Promise<number> {
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.runs)
    .where(eq(schema.runs.status, "queued"));
  return row?.count ?? 0;
}

/**
 * The lock dispatch holds while it decides. One key, not one per script VM.
 *
 * A per-host lock set cannot be taken safely: the hosts to lock are read from the
 * queue, and a run for a host that appears *after* that read would be admitted
 * with no lock held for it — so two processes could each see that VM idle and put
 * a run on it. Locking what a query returned is not locking what matters. One
 * dispatch-wide lock has no such window, and it costs what dispatch costs: four
 * short queries, once per sweep and once per start request.
 *
 * The number is arbitrary and must stay stable — it is the identity two processes
 * agree on, and renaming it is renaming a lock.
 */
const DISPATCH_LOCK = 4_812_013_001n;

/**
 * O-7 — admit queued runs to their script VMs, oldest first, and mark them
 * dispatched in the same breath.
 *
 * The whole function is one transaction holding `DISPATCH_LOCK`: what a script VM
 * is carrying and the mark that adds to it have to be indivisible, or two
 * processes — a start request and a sweep, or two control planes in one
 * deployment — can each see one free slot and admit a run into it.
 *
 * Capacity is counted from the database and includes runs a worker has only
 * *started* to open a connection for, because those are on the VM too — and runs
 * dispatched but not yet claimed, which is the case a sweep apart from the job
 * push would miss.
 */
export async function admitForDispatch(
  perHostLimit: number,
  batch: number,
): Promise<AdmittedRun[]> {
  if (perHostLimit < 1 || batch < 1) return [];

  return db().transaction(async (tx) => {
    // One lock for the whole decision — see DISPATCH_LOCK for why a per-host set
    // is not safe. The count, the candidates and the mark below are then a
    // snapshot that nothing else can dispatch into.
    await tx.execute(sql`select pg_advisory_xact_lock(${DISPATCH_LOCK})`);

    const busy = await tx
      .select({ host: schema.runs.host, count: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(
        or(
          inArray(schema.runs.status, ["starting", "running"]),
          and(eq(schema.runs.status, "queued"), isNotNull(schema.runs.dispatchedAt)),
        ),
      )
      .groupBy(schema.runs.host);

    const candidates = await tx
      .select({ id: schema.runs.id, host: schema.runs.host, queuedAt: schema.runs.queuedAt })
      .from(schema.runs)
      .where(and(eq(schema.runs.status, "queued"), isNull(schema.runs.dispatchedAt)))
      .orderBy(asc(schema.runs.queuedAt), asc(schema.runs.id))
      .limit(batch);

    const admitted = chooseAdmissions(
      candidates,
      new Map(busy.map((row) => [row.host, row.count])),
      perHostLimit,
      batch,
    );
    if (admitted.length === 0) return [];

    const marked = await tx
      .update(schema.runs)
      .set({ dispatchedAt: sql`now()` })
      .where(inArray(schema.runs.id, admitted))
      .returning({ id: schema.runs.id, host: schema.runs.host, queuedAt: schema.runs.queuedAt });

    // RETURNING does not preserve the order of the `IN` list — it hands back rows in
    // whatever order the update produced them, which is storage order. The caller
    // pushes jobs in the order it is given, and the queue is FIFO, so the order here is
    // the order runs start in: oldest first, as `chooseAdmissions` decided. Measured as
    // a 2-in-20 test failure that swapped two ids, which is what a promise about order
    // looks like when nothing tests it.
    const byId = new Map(marked.map((row) => [row.id, row]));
    return admitted.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  });
}
