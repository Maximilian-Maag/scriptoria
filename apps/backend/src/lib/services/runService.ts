import type {
  AbortRunRequest,
  Run,
  RunEvent,
  RunListQuery,
  RunTranscript,
  StartRunRequest,
} from "@scriptoria/contracts";
import { isTerminalStatus, redisKeys, type RunControl, type RunJob } from "@scriptoria/contracts";
import { authoriseAbort, canAccessArea, effectiveCriticality } from "@scriptoria/core";
import { auditRepository as audit, runRepository, scriptRepository } from "@scriptoria/db";
import type { Session } from "../auth/session";
import { keys, redis } from "../redis";
import { conflict, err, forbidden, notFound, ok, type Result } from "../result";

/**
 * FA-05 and FA-08 — the run state machine, and the only component that may
 * dispatch one.
 *
 * There is nothing to parametrise. FA-05.5 is explicit: either the parameter set
 * is fixed in the script, or it is asked for through dialogue *after* the start.
 * So starting a run takes a script id and the size of the terminal the operator
 * is looking at, and that second one is a property of their window rather than
 * of the script.
 */

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * How long a run may hold a claim-less `running` row before it is treated as
 * orphaned. Comfortably longer than a worker takes to claim a run and open an
 * SSH connection, because reaping a run that is merely slow to start would kill
 * it for no reason.
 */
const ORPHAN_GRACE_MS = 60_000;

export async function startRun(
  session: Session,
  request: StartRunRequest,
  context: { sourceIp?: string | null },
): Promise<Result<Run>> {
  // Scoped to the session's areas in the query itself, so that a script id
  // guessed or pasted from somewhere else cannot be started.
  const found = await scriptRepository.findScriptInAreas(request.scriptId, session.areaIds);
  if (!found) return notFound("No such script");

  const { script, source } = found;
  const criticality = effectiveCriticality(script.criticalityOverride, script.header);

  const run = await runRepository.createRun({
    areaId: script.areaId,
    scriptId: script.id,
    // Denormalised at start time on purpose: a later header edit or override
    // must not rewrite what the operator was warned about when they started it.
    scriptFileName: script.fileName,
    scriptTitle: script.header?.title ?? script.fileName,
    criticality,
    host: source.host,
    outputPath: script.header?.outputs ?? source.outputPath,
    startedBy: session.username,
    trigger: "manual",
    cols: request.cols ?? DEFAULT_COLS,
    rows: request.rows ?? DEFAULT_ROWS,
  });

  const job: RunJob = { runId: run.id, queuedAt: run.queuedAt };
  await redis().lpush(keys.runQueue, JSON.stringify(job));

  await audit.record({
    actor: session.username,
    action: "run_started",
    subject: script.fileName,
    areaId: script.areaId,
    runId: run.id,
    detail: { criticality, host: source.host },
    sourceIp: context.sourceIp ?? null,
  });

  return ok(run);
}

export async function getRun(session: Session, runId: string): Promise<Result<Run>> {
  const run = await runRepository.getRun(runId);
  if (!run || !canAccessArea(session.areaIds, run.areaId)) return notFound("No such run");
  return ok(await reapIfOrphaned(run));
}

export async function listRuns(
  session: Session,
  filter: RunListQuery,
): Promise<Result<{ items: Run[]; total: number; limit: number; offset: number }>> {
  const { items, total } = await runRepository.listRuns(session.areaIds, filter);
  return ok({ items, total, limit: filter.limit, offset: filter.offset });
}

export async function listEvents(session: Session, runId: string): Promise<Result<RunEvent[]>> {
  const run = await getRun(session, runId);
  if (!run.ok) return run;
  return ok(await runRepository.listEvents(runId));
}

/**
 * FA-07.2 — the scrollback of a run that is over, from the durable copy.
 *
 * The live stream is capped and expires; this does not. A run opened a month
 * later shows the same bytes it showed while it was running.
 */
export async function getTranscript(
  session: Session,
  runId: string,
): Promise<Result<RunTranscript>> {
  const run = await getRun(session, runId);
  if (!run.ok) return run;

  const transcript = await runRepository.getTranscript(runId);
  if (!transcript) {
    // A run that never produced one is not an error: many scripts deliberately
    // print nothing at all (FA-07.5), and a run that is still going has not
    // been persisted yet — the live stream is where its output is.
    return ok({ runId, contentBase64: "", sizeBytes: 0, truncated: false });
  }

  return ok({
    runId,
    contentBase64: transcript.content,
    sizeBytes: transcript.sizeBytes,
    truncated: transcript.truncated,
  });
}

/**
 * FA-08 / ADR-003. Requesting the abort is all this does: the staged escalation
 * happens in the worker holding the PTY, because that is where the process is.
 *
 * The confirmation is checked here, before the request is published, and it is
 * the script's own file name rather than a yes/no box. The thing being
 * prevented is stopping the *wrong* run out of a list, and a yes/no box does
 * not prevent that.
 */
export async function abortRun(
  session: Session,
  runId: string,
  request: AbortRunRequest,
  context: { sourceIp?: string | null },
): Promise<Result<null>> {
  const found = await runRepository.getRun(runId);
  if (!found || !canAccessArea(session.areaIds, found.areaId)) return notFound("No such run");

  if (isTerminalStatus(found.status)) {
    return conflict(`This run already ${found.status === "aborted" ? "was aborted" : "finished"}`);
  }

  const authorised = authoriseAbort(
    found.criticality,
    found.scriptFileName,
    request.confirmScriptName,
  );
  if (!authorised.ok) {
    await audit.record({
      actor: session.username,
      action: "run_aborted",
      subject: found.scriptFileName,
      areaId: found.areaId,
      runId,
      outcome: "failure",
      detail: { reason: authorised.reason, criticality: found.criticality },
      sourceIp: context.sourceIp ?? null,
    });

    return authorised.reason === "confirmation_required"
      ? forbidden(
          `${found.scriptFileName} modifies target systems. Confirm by naming the script to stop it.`,
        )
      : err("validation_failed", "The confirmation does not name this script");
  }

  await runRepository.recordAbortRequest(runId, session.username);

  const control: RunControl = {
    type: "abort",
    requestedBy: session.username,
    at: new Date().toISOString(),
  };
  await redis().publish(redisKeys.runControl(runId), JSON.stringify(control));

  await audit.record({
    actor: session.username,
    action: "run_aborted",
    subject: found.scriptFileName,
    areaId: found.areaId,
    runId,
    detail: { criticality: found.criticality, status: found.status },
    sourceIp: context.sourceIp ?? null,
  });

  return ok(null);
}

/**
 * A run whose worker died leaves a row saying `running` and a PTY that no
 * longer exists. The claim key is what tells them apart: it is renewed while a
 * worker holds the run, so its absence means nobody does.
 *
 * Called from the run reads rather than by a sweeper, because a stale row only
 * matters to somebody looking at it.
 */
export async function reapIfOrphaned(run: Run): Promise<Run> {
  if (isTerminalStatus(run.status) || run.status === "queued") return run;

  const held = await redis().exists(keys.runClaim(run.id));
  if (held) return run;

  // Only after a grace period: a worker that has just claimed the run writes
  // the key and the row in that order, and reaping in between would kill a run
  // that is about to start perfectly well.
  const startedAt = run.startedAt ? Date.parse(run.startedAt) : Date.parse(run.queuedAt);
  if (Date.now() - startedAt < ORPHAN_GRACE_MS) return run;

  await runRepository.transition(
    run.id,
    "failed",
    { finishedAt: new Date(), failureReason: "worker_lost" },
    ["starting", "running"],
  );
  await runRepository.appendEvent(run.id, "error", "The worker holding this run is gone");

  return { ...run, status: "failed", failureReason: "worker_lost" };
}
