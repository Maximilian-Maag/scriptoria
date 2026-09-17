import { z } from "zod";
import { listSchedules } from "@/lib/services/scheduleService";
import { parseQuery, requireSession } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

const querySchema = z.object({ areaId: z.string().uuid().optional() });

/**
 * FA-10.1 — which scripts run regularly.
 *
 * Read live off each script VM's crontab on every request (ADR-005). There is
 * no cached copy to go stale, which is the point: a schedule somebody changed
 * over SSH shows up here without anyone telling the platform.
 *
 * Available to administrators, not only to root. Seeing what runs in an area is
 * part of the area (FA-03.3); *changing* it is the root account's job.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  const query = parseQuery(request, querySchema);
  if (!query.ok) return toResponse(query);

  return toResponse(
    await listSchedules(session.value, query.value.areaId ? { areaId: query.value.areaId } : {}),
  );
}
