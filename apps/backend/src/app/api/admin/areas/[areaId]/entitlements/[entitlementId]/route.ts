import { revokeEntitlement } from "@/lib/services/areaService";
import { clientIp, parsePath, requireRoot } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * Revokes a group's entitlement, and — this is the part NFR-03 is about — the
 * live sessions that resolved their areas through it lose the area in the same
 * request, without being signed out.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ areaId: string; entitlementId: string }> },
): Promise<Response> {
  const session = await requireRoot(request);
  if (!session.ok) return toResponse(session);

  const { areaId, entitlementId } = await params;
  const path = parsePath({ areaId, entitlementId });
  if (!path.ok) return toResponse(path);
  return toResponse(
    await revokeEntitlement(session.value, areaId, entitlementId, {
      sourceIp: clientIp(request),
    }),
  );
}
