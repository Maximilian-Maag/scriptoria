import type {
  AbortRunRequest,
  Paginated,
  Run,
  RunEvent,
  RunListQuery,
  RunTranscript,
  StartRunRequest,
} from "@scriptoria/contracts";
import { isTerminalStatus, redisKeys, type RunControl } from "@scriptoria/contracts";
import { authoriseAbort, canAccessArea, effectiveCriticality } from "@scriptoria/core";
import { auditRepository as audit, runRepository, scriptRepository } from "@scriptoria/db";
import type { Session } from "../auth/session";
import { redis } from "../redis";
import { dispatchQueuedRuns } from "./runDispatch";
import { reapIfOrphaned } from "./runReaper";

/**
 * ADR-011's reaper lives in its own module because dispatch needs it too — a run
 * whose worker died still occupies its script VM (ADR-013) — and exported here as
 * well, because this service is where the run reads that trigger it live.
 */
export { reapIfOrphaned };
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

  // FA-03.3: a script the newest scan did not find is shown as vanished, and the
  // entry exists for its history rather than as something to run. Starting it
  // would open an SSH session to a path that is not there and fail in the
  // terminal, which reads as a broken script VM rather than as a stale list.
  if (!scriptRepository.isPresent(script)) {
    return conflict("This script is no longer on the script VM. Rescan the catalog.");
  }

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

  // O-7 / ADR-013: a start request does not push a job, it asks whether this
  // script VM can take one. When it cannot, the run stays `queued` and the sweep
  // starts it when the VM is free — the difference the operator sees is a status
  // line, not a refusal.
  await dispatchQueuedRuns();

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

/**
 * FA-05.4 and FA-09.5 — the history that makes a finished run findable again.
 *
 * Bounded by the session's areas in the repository, so an administrator's list
 * cannot contain a run from an area they are not entitled to (NFR-18). An
 * empty area set produces an empty list rather than every run.
 *
 * The rows are reaped on the way out for the same reason single reads are: a
 * stale row only matters to somebody looking at it, and a list is somebody
 * looking at it. Without this a run whose worker died shows as `Running`
 * forever in the one view somebody would open to find out what happened to it.
 * Only non-terminal rows cost anything — a finished run returns before it
 * touches Redis, and in any realistic list nearly all of them are finished.
 */
export async function listRuns(
  session: Session,
  filter: RunListQuery,
): Promise<Result<Paginated<Run>>> {
  const { items, total } = await runRepository.listRuns(session.areaIds, filter);
  const reaped = await Promise.all(items.map((run) => reapIfOrphaned(run)));
  return ok({ items: reaped, total, limit: filter.limit, offset: filter.offset });
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

  // FA-08.1 / ADR-003 — a run that has not started is not a run to signal, it is
  // a run to cancel.
  //
  // A `queued` run has no worker holding it and no PTY to signal: nothing is
  // subscribed to its control channel, so a published stop reaches nobody, and
  // `recordAbortRequest` was read by nobody (#50). The worker's claim is what
  // decides the race — if this transition lands, the run never starts, because
  // the claim is guarded on `queued` and a worker that loses that guard stands
  // down. If it does not land, the worker got there first and the request has to
  // reach it the other way, below.
  if (found.status === "queued") {
    const cancelled = await runRepository.transition(
      runId,
      "aborted",
      { finishedAt: new Date(), failureReason: "aborted_by_user", collectedAt: new Date() },
      ["queued"],
    );

    if (cancelled) {
      await runRepository.appendEvent(
        runId,
        "abort_requested",
        `Requested by ${session.username} before the run started`,
      );

      await audit.record({
        actor: session.username,
        action: "run_aborted",
        subject: found.scriptFileName,
        areaId: found.areaId,
        runId,
        detail: { criticality: found.criticality, status: "queued" },
        sourceIp: context.sourceIp ?? null,
      });

      return ok(null);
    }
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
