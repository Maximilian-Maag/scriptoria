import { resultArchiveRequestSchema } from "@scriptoria/contracts";
import { sanitiseFileName } from "@scriptoria/core";
import { archiveResults } from "@/lib/services/resultService";
import { clientIp, parseBody, parsePath, requireSession } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * FA-09.3 — the result set as one ZIP.
 *
 * A POST rather than a GET because the selection travels in the body: a run can
 * produce thousands of files and a list of chosen paths does not belong in a
 * query string. An empty `paths` means the whole set, which is the usual case.
 *
 * The archive streams as it is built, so the response starts before the last
 * file has been read off the script VM. That means the status is committed
 * before the outcome is known — a file that cannot be read partway through
 * truncates the download rather than turning it into a 502. The alternative is
 * buffering an archive of hundreds of files in memory to find out whether it
 * will succeed, which for the size these reach is not an alternative.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  const body = await parseBody(request, resultArchiveRequestSchema);
  if (!body.ok) return toResponse(body);

  const { runId } = await params;
  const path = parsePath({ runId });
  if (!path.ok) return toResponse(path);
  const result = await archiveResults(session.value, runId, body.value, {
    sourceIp: clientIp(request),
  });
  if (!result.ok) return toResponse(result);

  const { body: archive, name, fileCount } = result.value;

  return new Response(archive, {
    headers: new Headers({
      "content-type": "application/zip",
      // The service derives the name from the script's, which is whatever the
      // catalog scan recorded from the script VM. Sanitised here as well,
      // because this is where it becomes a header value and `Headers` refuses
      // a newline or anything outside Latin-1 by throwing — a non-Latin-1
      // script name would otherwise turn the whole ZIP into a 500.
      "content-disposition": `attachment; filename="${sanitiseFileName(name)}"`,
      // No content-length: the compressed size is not known until the last
      // entry is written, and a wrong one is worse than none.
      "cache-control": "no-store",
      "x-scriptoria-file-count": String(fileCount),
    }),
  });
}
