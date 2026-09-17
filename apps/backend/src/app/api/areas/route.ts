import { listAreas } from "@/lib/services/areaService";
import { requireSession } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * FA-03.1 — the areas of the session, and the left navigation's only input.
 *
 * An empty array is a valid, expected answer (FA-01.4). It is not a 403 and
 * must not be rendered as an error.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  return toResponse(await listAreas(session.value));
}
