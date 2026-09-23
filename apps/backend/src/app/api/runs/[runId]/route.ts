import { abortRunRequestSchema } from "@scriptoria/contracts";
import { abortRun, getRun } from "@/lib/services/runService";
import { clientIp, parseOptionalBody, parsePath, requireSession } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/** FA-07.4 — what the status line above the terminal reads. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  const { runId } = await params;
  const path = parsePath({ runId });
  if (!path.ok) return toResponse(path);
  return toResponse(await getRun(session.value, runId));
}

/**
 * FA-08 — stops a running script.
 *
 * A DELETE with a body, because ADR-003's confirmation has to travel with the
 * request: a modifying script is stopped by naming it, not by clicking yes.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  // An abort with no body at all is the read-only case, which needs no
  // confirmation — so a request carrying nothing is an empty one, not a
  // malformed one.
  const body = await parseOptionalBody(request, abortRunRequestSchema);
  if (!body.ok) return toResponse(body);

  const { runId } = await params;
  const path = parsePath({ runId });
  if (!path.ok) return toResponse(path);
  return toResponse(
    await abortRun(session.value, runId, body.value, { sourceIp: clientIp(request) }),
  );
}
