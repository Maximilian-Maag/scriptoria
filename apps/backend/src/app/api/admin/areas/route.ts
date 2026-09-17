import { createAreaRequestSchema } from "@scriptoria/contracts";
import { createArea, listAllAreas } from "@/lib/services/areaService";
import { clientIp, parseBody, requireRoot } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * FA-11. Everything under `/api/admin` is `requireRoot` and nothing else —
 * the guard is the first line of every handler, so which routes are privileged
 * can be established by reading the path rather than by tracing a service call.
 *
 * Root is not a bigger administrator. These routes decide what administrators
 * can reach; they do not let anybody reach further themselves.
 */

/** Every area that exists, not every area the caller is entitled to. */
export async function GET(request: Request): Promise<Response> {
  const session = await requireRoot(request);
  if (!session.ok) return toResponse(session);

  return toResponse(await listAllAreas());
}

/** FA-11.1, FA-11.5 */
export async function POST(request: Request): Promise<Response> {
  const session = await requireRoot(request);
  if (!session.ok) return toResponse(session);

  const body = await parseBody(request, createAreaRequestSchema);
  if (!body.ok) return toResponse(body);

  return toResponse(await createArea(session.value, body.value, { sourceIp: clientIp(request) }), {
    status: 201,
  });
}
