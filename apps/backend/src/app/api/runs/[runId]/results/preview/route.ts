import { resultPreviewQuerySchema } from "@scriptoria/contracts";
import { previewResult } from "@/lib/services/resultService";
import { parsePath, parseQuery, requireSession } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * FA-09.1 / FA-09.4 — a result's content, to read on screen and to copy.
 *
 * Deliberately not the download route with a different header. A download puts
 * a file on a disk; this answers with JSON a page can render and a person can
 * put on their clipboard, which FA-09.4 names as its own form of provisioning.
 * It is capped, and the cap is visible in the answer.
 *
 * Not audited, unlike the download. Reading a result on screen is the same act
 * as watching it scroll past in the terminal, and FA-12.2 asks for downloads.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  const query = parseQuery(request, resultPreviewQuerySchema);
  if (!query.ok) return toResponse(query);

  const { runId } = await params;
  const path = parsePath({ runId });
  if (!path.ok) return toResponse(path);
  return toResponse(await previewResult(session.value, runId, query.value));
}
