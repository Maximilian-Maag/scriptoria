import { listResults } from "@/lib/services/resultService";
import { parsePath, requireSession } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * FA-09.1 — what this run wrote.
 *
 * Listed for failed and aborted runs too (FA-09.5): the exit code ends the run,
 * it does not decide whether what the run produced is worth seeing.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  const { runId } = await params;
  const path = parsePath({ runId });
  if (!path.ok) return toResponse(path);
  return toResponse(await listResults(session.value, runId));
}
