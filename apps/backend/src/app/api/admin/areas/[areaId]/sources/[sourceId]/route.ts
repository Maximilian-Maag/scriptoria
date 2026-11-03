import { removeSource } from "@/lib/services/areaService";
import { clientIp, parsePath, requireRoot } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * Unmaps a path. The scripts already scanned from it stay in the catalog — a
 * script row is referenced by the runs that used it, and FA-12.1 wants those
 * readable. What changes is that nothing new is scanned from here.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ areaId: string; sourceId: string }> },
): Promise<Response> {
  const session = await requireRoot(request);
  if (!session.ok) return toResponse(session);

  const { areaId, sourceId } = await params;
  const path = parsePath({ areaId, sourceId });
  if (!path.ok) return toResponse(path);
  return toResponse(
    await removeSource(session.value, areaId, sourceId, { sourceIp: clientIp(request) }),
  );
}
