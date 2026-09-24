import { z } from "zod";
import { sanitiseFileName } from "@scriptoria/core";
import { downloadResult } from "@/lib/services/resultService";
import { clientIp, parsePath, parseQuery, requireSession } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

const querySchema = z.object({ path: z.string().min(1).max(4096) });

/**
 * FA-09.2 / FA-09.6 — one result file, without a jump server and without SFTP
 * by hand.
 *
 * The bytes are streamed: script VM → runner → Redis → here → browser, with
 * nothing on the path holding the whole file. A result set is routinely
 * hundreds of files and occasionally a very large one.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  const query = parseQuery(request, querySchema);
  if (!query.ok) return toResponse(query);

  const { runId } = await params;
  const path = parsePath({ runId });
  if (!path.ok) return toResponse(path);
  const result = await downloadResult(session.value, runId, query.value.path, {
    sourceIp: clientIp(request),
  });
  if (!result.ok) return toResponse(result);

  const { header, body, name, contentType } = result.value;
  const headers = new Headers({
    "content-type": contentType,
    // `attachment`, always. A result file is the script owner's content and
    // this platform does not render other people's HTML in its own origin.
    //
    // The name is the one the script VM reported, so it is sanitised rather
    // than interpolated: a newline or anything outside Latin-1 is legal in a
    // file name there and makes this header value invalid, which `Headers`
    // throws on — one such file would turn its own download into a 500.
    "content-disposition": `attachment; filename="${sanitiseFileName(name)}"`,
    "cache-control": "no-store",
  });
  if (!header.truncated) headers.set("content-length", String(header.sizeBytes));

  return new Response(body, { headers });
}
