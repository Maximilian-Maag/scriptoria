import { auditQuerySchema } from "@scriptoria/contracts";
import { queryAuditLog } from "@/lib/services/auditService";
import { parseQuery, requireRoot } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * FA-12 — the recorded history of the platform, filtered by actor, action, area,
 * run and time window.
 *
 * Under `/api/admin` and therefore `requireRoot`, like everything else here —
 * ADR-008 argues why the log is root's alone rather than area-scoped.
 *
 * Reading the log is deliberately *not* itself audited. A read changes nothing,
 * and recording every page of every search would bury the acts the log exists
 * for under the searches for them.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await requireRoot(request);
  if (!session.ok) return toResponse(session);

  const query = parseQuery(request, auditQuerySchema);
  if (!query.ok) return toResponse(query);

  return toResponse(await queryAuditLog(query.value));
}
