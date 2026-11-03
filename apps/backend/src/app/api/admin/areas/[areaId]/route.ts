import { updateAreaRequestSchema } from "@scriptoria/contracts";
import { deleteArea, getArea, updateArea } from "@/lib/services/areaService";
import { clientIp, parseBody, parsePath, requireRoot } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ areaId: string }> },
): Promise<Response> {
  const session = await requireRoot(request);
  if (!session.ok) return toResponse(session);

  const { areaId } = await params;
  const path = parsePath({ areaId });
  if (!path.ok) return toResponse(path);
  return toResponse(await getArea(areaId));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ areaId: string }> },
): Promise<Response> {
  const session = await requireRoot(request);
  if (!session.ok) return toResponse(session);

  const body = await parseBody(request, updateAreaRequestSchema);
  if (!body.ok) return toResponse(body);

  const { areaId } = await params;
  const path = parsePath({ areaId });
  if (!path.ok) return toResponse(path);
  return toResponse(
    await updateArea(session.value, areaId, body.value, { sourceIp: clientIp(request) }),
  );
}

/**
 * Deletes an area that nothing has ever run in. One that has runs against it is
 * a 409 rather than a cascade — FA-12.1's history outranks tidying up.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ areaId: string }> },
): Promise<Response> {
  const session = await requireRoot(request);
  if (!session.ok) return toResponse(session);

  const { areaId } = await params;
  const path = parsePath({ areaId });
  if (!path.ok) return toResponse(path);
  return toResponse(await deleteArea(session.value, areaId, { sourceIp: clientIp(request) }));
}
