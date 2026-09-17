import { getTranscript } from "@/lib/services/runService";
import { requireSession } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * FA-07.2 — the scrollback of a run that is over.
 *
 * The console loads this when a run has already finished; while it is running,
 * the same bytes arrive on the WebSocket instead.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  const { runId } = await params;
  return toResponse(await getTranscript(session.value, runId));
}
