import type { AbortStage, RunFailureReason } from "@scriptoria/contracts";
import { resultRepository, runRepository, schema, scriptRepository } from "@scriptoria/db";
import { connectTo } from "../driver/sshTarget";
import type { DirectoryEntry, ExecutionTarget } from "../driver/executionTarget";
import { StreamPublisher } from "../stream/publisher";
import { ControlSubscriber } from "../stream/control";
import { StagedAbort } from "./abort";
import { Transcript } from "./transcript";
import { describeError, log } from "../log";

/** How often the claim is renewed while the script is running. */
const CLAIM_RENEWAL_MS = 20_000;

export interface RunContext {
  workerId: string;
  /** Renews this worker's hold on the run, so a second one cannot take it. */
  renewClaim: () => Promise<void>;
}

/**
 * The last line of defence, and the reason it is here rather than in the job
 * consumer: once a job has been claimed, a run that nobody carries to a
 * terminal state is a run nothing will ever pick up again. The job has already
 * been consumed from the queue, the claim is released as the worker unwinds,
 * and the reaper only looks at runs somebody opens — where a database blip
 * would be called `worker_lost`, which is a worse description of what happened
 * than this one (FA-05).
 */
export async function executeRun(runId: string, context: RunContext): Promise<void> {
  try {
    await runOnce(runId, context);
  } catch (cause) {
    log.error("the run could not be carried out", { runId, error: describeError(cause) });
    await fail(runId, "start_failed", describeError(cause)).catch((unrecorded: unknown) => {
      // With the database unreachable there is nowhere to record that the run
      // never started. This line is then the only trace there will be.
      log.error("could not record that the run failed to start", {
        runId,
        error: describeError(unrecorded),
      });
    });
  }
}

/**
 * One run, from a claimed job to a terminal state.
 *
 * The order of what happens here is the product's promise, in sequence:
 * connect, open a terminal, stream every byte both ways, stop when asked, and
 * then — whatever the exit code was — record what the script left behind.
 * FA-09.5 is explicit that a failed run still has results, because a partial
 * result is evidence about what the run managed to do.
 */
async function runOnce(runId: string, context: RunContext): Promise<void> {
  const run = await runRepository.findRunById(runId);
  if (!run) {
    log.warn("queued run has no record", { runId });
    return;
  }

  // The guard is the state, not the claim: a worker that lost its lease and
  // came back cannot restart a run that has already moved on.
  const claimed = await runRepository.transition(runId, "starting", { workerId: context.workerId }, [
    "queued",
  ]);
  if (!claimed) {
    log.info("run was not in a startable state", { runId, status: run.status });
    return;
  }
  await runRepository.appendEvent(runId, "claimed", `Claimed by ${context.workerId}`);

  const script = await scriptRepository.findScriptWithSource(run.scriptId);
  if (!script) {
    await fail(runId, "start_failed", "The script is no longer in the catalog");
    return;
  }

  let target: ExecutionTarget | undefined;
  try {
    target = await connectTo({
      host: script.source.host,
      port: script.source.port,
      username: script.source.username,
    });
  } catch (cause) {
    log.error("could not reach the script VM", {
      runId,
      host: script.source.host,
      error: describeError(cause),
    });
    await fail(runId, "connect_failed", `Could not reach ${script.source.host}: ${describeError(cause)}`);
    return;
  }

  await runRepository.appendEvent(runId, "connected", `Connected to ${script.source.host}`);

  try {
    await drive(run, script, target, context);
  } catch (cause) {
    log.error("run failed", { runId, error: describeError(cause) });
    await fail(runId, "connection_lost", describeError(cause));
  } finally {
    await target.cleanup(runId).catch(() => {});
    target.close();
  }
}

async function drive(
  run: schema.RunRow,
  script: { script: schema.ScriptRow; source: schema.ScriptSourceRow },
  target: ExecutionTarget,
  context: RunContext,
): Promise<void> {
  const runId = run.id;

  // Listed before the script starts, so that "what this run produced" is
  // decided by comparison rather than by trusting two machines' clocks to
  // agree. The export directory usually already holds earlier runs' files.
  const before = await snapshot(target, run.outputPath);

  const facts = await target.stat(script.script.absolutePath);
  if (!facts) {
    await fail(runId, "start_failed", `${script.script.absolutePath} is not there any more`);
    return;
  }

  const running = await target.start({
    runId,
    absolutePath: script.script.absolutePath,
    fileName: script.script.fileName,
    workingDirectory: script.source.scriptPath,
    executable: facts.executable,
    cols: run.cols,
    rows: run.rows,
  });
  await runRepository.appendEvent(runId, "pty_opened", `${run.cols}x${run.rows} PTY allocated`);

  const publisher = new StreamPublisher(runId);
  const transcript = new Transcript();

  running.onData((chunk) => {
    publisher.publish(chunk);
    transcript.append(chunk);
  });

  const abort = new StagedAbort(runId, running, async (stage: AbortStage) => {
    await runRepository.appendEvent(runId, "abort_signalled", `Signalled ${stage}`, stage);
    await runRepository.transition(runId, "running", { abortStage: stage }, ["running"]);
  });

  const control = new ControlSubscriber(runId, {
    // Straight into the PTY, unparsed. This is the operator answering a
    // dialogue (FA-06.1), and it is nobody's business what they typed.
    onStdin: (data) => running.write(data),
    onControl: (message) => {
      if (message.type === "resize") {
        running.resize(message.cols, message.rows);
        return;
      }
      void runRepository
        .appendEvent(runId, "abort_requested", `Requested by ${message.requestedBy}`)
        .catch(() => {});
      abort.request();
    },
  });

  const renewal = setInterval(() => {
    void context.renewClaim().catch((cause: unknown) => {
      log.warn("could not renew the run claim", { runId, error: describeError(cause) });
    });
  }, CLAIM_RENEWAL_MS);

  await runRepository.transition(runId, "running", { startedAt: new Date() }, ["starting"]);
  await runRepository.appendEvent(runId, "started", `Started ${script.script.fileName}`);

  try {
    const exit = await running.exit;
    await publisher.flush();

    const status = abort.wasRequested ? "aborted" : exit.code === 0 ? "succeeded" : "failed";
    const failureReason: RunFailureReason | null = abort.wasRequested
      ? "aborted_by_user"
      : exit.code === 0
        ? null
        : exit.signal
          ? "connection_lost"
          : "exit_code";

    await runRepository.transition(
      runId,
      status,
      {
        finishedAt: new Date(),
        exitCode: exit.code,
        failureReason,
        lastStreamId: publisher.lastStreamId,
        abortStage: abort.stage,
      },
      ["running", "starting"],
    );
    await runRepository.appendEvent(
      runId,
      "exited",
      exit.signal ? `Killed by ${exit.signal}` : `Exited ${exit.code ?? "unknown"}`,
    );

    // FA-07.2: the durable copy of the scrollback, so the capped stream may
    // expire without taking the history with it.
    //
    // Kept out of the collection's `try` below, because they are two promises
    // and neither may take the other down with it. Sharing one made the
    // transcript the collection's failure: a database blip on the way in meant a
    // run that wrote files showed none of them, permanently and with no error a
    // person would trust — the failure was reported against a run already
    // written `succeeded`, so the record meant to say so was itself rejected.
    // The scrollback is recoverable from nothing, so losing it is worth a run
    // event; losing the results is what FA-09.5 exists to forbid.
    try {
      await runRepository.saveTranscript(
        runId,
        transcript.toBase64(),
        transcript.sizeBytes,
        transcript.truncated,
      );
    } catch (cause) {
      log.error("could not persist the transcript", { runId, error: describeError(cause) });
      await runRepository.appendEvent(
        runId,
        "error",
        `Transcript not persisted: ${describeError(cause)}`,
      );
    }

    await collect(target, runId, run.outputPath, before);
  } finally {
    clearInterval(renewal);
    control.close();
    await publisher.expire();
  }
}

/** Path → the size and mtime it had before the run started. */
type Snapshot = Map<string, string>;

const fingerprint = (entry: DirectoryEntry): string =>
  `${entry.sizeBytes}:${entry.modifiedAt.getTime()}`;

async function snapshot(target: ExecutionTarget, directory: string): Promise<Snapshot> {
  try {
    const listing = await target.list(directory);
    return new Map(listing.entries.map((entry) => [entry.path, fingerprint(entry)]));
  } catch (cause) {
    // The export directory not existing yet is the normal case for a script
    // that creates its own (NFR-21). An empty snapshot is the right answer.
    log.debug("no snapshot of the output directory", {
      directory,
      error: describeError(cause),
    });
    return new Map();
  }
}

/**
 * FA-09. What this run left behind: everything in the output directory that was
 * not there before, or that changed while it ran.
 *
 * Comparison rather than a timestamp filter, because the alternative is trusting
 * the runner's clock and the script VM's clock to agree — and a few seconds of
 * skew there means results that silently do not appear.
 */
async function collect(
  target: ExecutionTarget,
  runId: string,
  directory: string,
  before: Snapshot,
): Promise<void> {
  try {
    const listing = await target.list(directory);
    const produced = listing.entries.filter((entry) => before.get(entry.path) !== fingerprint(entry));

    const count = await resultRepository.recordResults(
      runId,
      produced.map((entry) => ({
        path: entry.path,
        name: entry.name,
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
      })),
    );

    await runRepository.setResultCount(runId, count);
    await runRepository.appendEvent(
      runId,
      "collected",
      `${count} result file${count === 1 ? "" : "s"} in ${directory}`,
    );
  } catch (cause) {
    // A collection that failed must not rewrite how the run ended. The script
    // did what it did; this is the platform failing to look afterwards.
    log.error("could not collect the results", { runId, error: describeError(cause) });
    await runRepository.appendEvent(runId, "error", `Result collection failed: ${describeError(cause)}`);
  }
}

async function fail(runId: string, reason: RunFailureReason, message: string): Promise<void> {
  await runRepository.transition(
    runId,
    "failed",
    { finishedAt: new Date(), failureReason: reason },
    ["queued", "starting", "running"],
  );
  await runRepository.appendEvent(runId, "error", message);
}
