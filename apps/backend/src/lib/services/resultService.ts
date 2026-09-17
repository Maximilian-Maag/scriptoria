import type {
  ReadFileHeader,
  ResultArchiveRequest,
  ResultList,
  ResultPreview,
  ResultPreviewQuery,
  SshTarget,
} from "@scriptoria/contracts";
import { isTerminalStatus } from "@scriptoria/contracts";
import { canAccessArea } from "@scriptoria/core";
import {
  areaRepository,
  auditRepository as audit,
  resultRepository,
  runRepository,
} from "@scriptoria/db";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { ReadableStream as StreamWebReadable } from "node:stream/web";
import archiver from "archiver";
import type { Session } from "../auth/session";
import { readFile } from "../runner/client";
import { internal, notFound, ok, type Result } from "../result";

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

/**
 * Everything the three read paths need before they touch a file, and the one
 * place the authorisation for them lives.
 *
 * The path is matched against what the collector recorded rather than joined
 * onto the output directory. That *is* the authorisation: a file this run did
 * not produce is not reachable through this run, whatever the query string
 * says — which also means no amount of `../` in a path can walk out of it,
 * because the path is never used to build a lookup, only to find a record.
 *
 * The host comes from the run rather than from the area, because an area may
 * map more than one script VM (NFR-07) and reading a file from a different one
 * than wrote it would be a quiet way to serve the wrong file.
 */
async function resolveRun(
  session: Session,
  runId: string,
): Promise<
  Result<{
    run: NonNullable<Awaited<ReturnType<typeof runRepository.findRunById>>>;
    target: SshTarget;
  }>
> {
  const run = await runRepository.findRunById(runId);
  if (!run || !canAccessArea(session.areaIds, run.areaId)) return notFound("No such run");

  const sources = await areaRepository.listSourcesForAreas([run.areaId]);
  const source = sources.find((candidate) => candidate.host === run.host);
  if (!source) return notFound("The script VM this run used is no longer mapped to the area");

  return ok({
    run,
    target: { host: source.host, port: source.port, username: source.username },
  });
}

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
): Promise<
  Result<{
    header: ReadFileHeader;
    body: ReadableStream<Uint8Array>;
    name: string;
    contentType: string;
  }>
> {
  const resolved = await resolveRun(session, runId);
  if (!resolved.ok) return resolved;
  const { run, target } = resolved.value;

  const record = await resultRepository.findResult(runId, path);
  if (!record) return notFound("This run did not produce that file");

  const file = await readFile(target, `${run.outputPath}/${record.path}`, MAX_DOWNLOAD_BYTES);
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

/**
 * FA-09.4 — **copy**, which is a different act from download and deliberately
 * so. The requirement names three forms of provisioning: display, copy,
 * download. This one serves the first two: content a person reads on screen and
 * puts on their clipboard, to carry into a ticket or another system without a
 * file ever landing on their disk.
 *
 * Capped, and the cap is not a formality — a result file can be hundreds of
 * megabytes and nothing good happens when that is put in a `<pre>`. A truncated
 * preview says so and the download stays available for the whole thing.
 *
 * Decoded as UTF-8 with replacement characters. A preview is not a hex editor:
 * a binary file rendered here is meant to look wrong, so that the person looks
 * at the download button instead.
 */
export async function previewResult(
  session: Session,
  runId: string,
  query: ResultPreviewQuery,
): Promise<Result<ResultPreview>> {
  const resolved = await resolveRun(session, runId);
  if (!resolved.ok) return resolved;
  const { run, target } = resolved.value;

  const record = await resultRepository.findResult(runId, query.path);
  if (!record) return notFound("This run did not produce that file");

  const file = await readFile(target, `${run.outputPath}/${record.path}`, query.maxBytes);
  if (!file.ok) return file;

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = file.value.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch (cause) {
    return internal("The file could not be read in full", cause);
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks, total);

  return ok({
    path: record.path,
    contentType: record.contentType,
    content: body.toString("utf8"),
    // `truncated` comes from the runner, which is the only place that knows
    // whether the file went on past the cap — a read that happens to stop
    // exactly at the ceiling is not the same as a file that ends there.
    truncated: file.value.header.truncated,
    sizeBytes: record.sizeBytes,
  });
}

/**
 * FA-09.3 — many files as one ZIP.
 *
 * Not a convenience. One real run writes roughly 800 files across 133 sites,
 * and the state this product exists to abolish is somebody pulling those off a
 * jump server by hand (FA-09.6). Downloading them individually would be the
 * same handwork with a nicer button on it.
 *
 * The files are fetched **one at a time**, and that sequencing is the load
 * bearing part rather than an optimisation left undone. Every read is a request
 * on the runner's queue; appending 800 entries at once would put 800 requests
 * on it simultaneously, have the runner open that many SFTP reads, and buffer
 * every reply in Redis. So each entry waits for the archiver to finish
 * consuming the last one before the next request is sent, and exactly one file
 * is ever in flight.
 *
 * Nothing holds the whole archive: the entries stream from the script VM
 * through this process and out to the browser as they are compressed.
 */
export async function archiveResults(
  session: Session,
  runId: string,
  request: ResultArchiveRequest,
  context: { sourceIp?: string | null },
): Promise<Result<{ body: ReadableStream<Uint8Array>; name: string; fileCount: number }>> {
  const resolved = await resolveRun(session, runId);
  if (!resolved.ok) return resolved;
  const { run, target } = resolved.value;

  const all = await resultRepository.listResults(runId);

  // An empty `paths` means the whole result set — the common case, and the one
  // the button in the interface sends.
  const wanted =
    request.paths.length === 0 ? all : all.filter((file) => request.paths.includes(file.path));

  if (wanted.length === 0) {
    return notFound(
      request.paths.length === 0
        ? "This run produced no files to archive"
        : "None of those files belong to this run",
    );
  }

  const archive = archiver("zip", { zlib: { level: 6 } });

  // Driven outside the request's await: the response is returned as soon as the
  // archive has a stream, and the entries are fed into it as the browser pulls.
  void (async () => {
    try {
      for (const record of wanted) {
        const file = await readFile(target, `${run.outputPath}/${record.path}`, MAX_DOWNLOAD_BYTES);
        if (!file.ok) {
          // Bytes already sent cannot be recalled, so the archive is destroyed
          // rather than finished. The browser sees a truncated download, which
          // is the honest outcome — a ZIP that silently omits a file somebody
          // asked for is worse than one that visibly fails.
          archive.abort();
          console.error("archive aborted: a result file could not be read", {
            runId,
            path: record.path,
            message: file.message,
          });
          return;
        }
        archive.append(Readable.fromWeb(file.value.body as StreamWebReadable), {
          name: record.path,
          date: new Date(record.modifiedAt),
        });
        // One file in flight at a time. Without this the loop would issue every
        // request before the archiver had consumed the first reply.
        await once(archive, "entry");
      }
      await archive.finalize();
    } catch (cause) {
      console.error("archive failed", { runId, cause });
      archive.abort();
    }
  })();

  await audit.record({
    actor: session.username,
    action: "result_archive_downloaded",
    subject: `${wanted.length} files`,
    areaId: run.areaId,
    runId,
    detail: {
      fileCount: wanted.length,
      totalBytes: wanted.reduce((total, file) => total + file.sizeBytes, 0),
      whole: request.paths.length === 0,
    },
    sourceIp: context.sourceIp ?? null,
  });

  return ok({
    body: Readable.toWeb(archive) as ReadableStream<Uint8Array>,
    name: archiveName(run.scriptFileName, run.queuedAt),
    fileCount: wanted.length,
  });
}

/** Readable enough to find again in a downloads folder holding forty of these. */
function archiveName(scriptFileName: string, queuedAt: Date): string {
  const base = scriptFileName.replace(/\.[^.]+$/, "") || "results";
  const stamp = queuedAt.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${base}-${stamp}.zip`;
}
