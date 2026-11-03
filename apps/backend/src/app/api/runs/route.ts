import { runListQuerySchema, startRunRequestSchema } from "@scriptoria/contracts";
import { listRuns, startRun } from "@/lib/services/runService";
import { clientIp, parseBody, parseQuery, requireSession } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/** FA-05.1 — starts the selected script. Selection and start are two steps. */
export async function POST(request: Request): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  const body = await parseBody(request, startRunRequestSchema);
  if (!body.ok) return toResponse(body);

  const result = await startRun(session.value, body.value, { sourceIp: clientIp(request) });
  // 202, not 201: the run is accepted and queued. It is not running yet, and
  // saying so is what lets the console show "queued" honestly.
  return toResponse(result, { status: 202 });
}

export async function GET(request: Request): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  const query = parseQuery(request, runListQuerySchema);
  if (!query.ok) return toResponse(query);

  return toResponse(await listRuns(session.value, query.value));
}
