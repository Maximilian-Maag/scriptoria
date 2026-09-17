import type { ReadFileHeader, ResultList } from "@scriptoria/contracts";
import { isTerminalStatus } from "@scriptoria/contracts";
import { canAccessArea } from "@scriptoria/core";
import {
  areaRepository,
  auditRepository as audit,
  resultRepository,
  runRepository,
} from "@scriptoria/db";
import type { Session } from "../auth/session";
import { readFile } from "../runner/client";
import { notFound, ok, type Result } from "../result";

/**
 * FA-09 — the results of a run.
 *
 * A result is a *file written into a defined directory*, not the terminal. The
 * two are separate channels with separate lifecycles and they are modelled
 * separately all the way down; this service only ever deals with the first.
 *
 * FA-09.5 governs the whole file: results are listed and downloadable for
 * failed and aborted runs too. The exit code ends the run — it does not decide
 * whether what the run wrote is worth seeing.
 */

/** The ceiling on a single download. Generous: result sets are the product. */
const MAX_DOWNLOAD_BYTES = 1_073_741_824;

export async function listResults(session: Session, runId: string): Promise<Result<ResultList>> {
  const run = await runRepository.findRunById(runId);
  if (!run || !canAccessArea(session.areaIds, run.areaId)) return notFound("No such run");

  const files = await resultRepository.listResults(runId);
  const collectedAt = await resultRepository.collectedAt(runId);

  return ok({
    runId,
    directory: run.outputPath,
    files,
    totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    // A script writing 800 files across 133 sites is not done because five
    // appeared. The collector runs when the run ends, so anything before that
    // is by definition incomplete.
    partial: !isTerminalStatus(run.status),
    collectedAt: (collectedAt ?? new Date()).toISOString(),
  });
}

/**
 * FA-09.2 / FA-09.6 — one file, streamed from the script VM through the runner
 * and straight out to the browser.
 *
 * The path is matched against what the collector recorded rather than joined
 * onto the output directory. That is the authorisation: a file this run did not
 * produce is not downloadable through this run, whatever the query string says.
 */
export async function downloadResult(
  session: Session,
  runId: string,
  path: string,
  context: { sourceIp?: string | null },
): Promise<Result<{ header: ReadFileHeader; body: ReadableStream<Uint8Array>; name: string; contentType: string }>> {
  const run = await runRepository.findRunById(runId);
  if (!run || !canAccessArea(session.areaIds, run.areaId)) return notFound("No such run");

  const record = await resultRepository.findResult(runId, path);
  if (!record) return notFound("This run did not produce that file");

  // The run recorded which VM it ran on, and an area may map more than one
  // (NFR-07). Reading the file from a different host than the one that wrote it
  // would be a quiet way to serve the wrong file.
  const sources = await areaRepository.listSourcesForAreas([run.areaId]);
  const source = sources.find((candidate) => candidate.host === run.host);
  if (!source) return notFound("The script VM this run used is no longer mapped to the area");

  const file = await readFile(
    { host: source.host, port: source.port, username: source.username },
    `${run.outputPath}/${record.path}`,
    MAX_DOWNLOAD_BYTES,
  );
  if (!file.ok) return file;

  // FA-12.2: every download is audited. Recorded when the stream is handed
  // over rather than when it completes — a download the operator cancelled
  // halfway still put the file on their machine.
  await audit.record({
    actor: session.username,
    action: "result_downloaded",
    subject: record.name,
    areaId: run.areaId,
    runId,
    detail: { path: record.path, sizeBytes: record.sizeBytes },
    sourceIp: context.sourceIp ?? null,
  });

  return ok({
    header: file.value.header,
    body: file.value.body,
    name: record.name,
    contentType: record.contentType,
  });
}
