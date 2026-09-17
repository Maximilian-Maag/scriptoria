import { listEvents } from "@/lib/services/runService";
import { requireSession } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * What the *platform* did, as opposed to what the process printed: claimed,
 * connected, started, signalled, exited, collected. The terminal is the other
 * channel, and it is a WebSocket.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  const { runId } = await params;
  return toResponse(await listEvents(session.value, runId));
}
