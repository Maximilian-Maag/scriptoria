import { createGroupEntitlementRequestSchema } from "@scriptoria/contracts";
import { grantEntitlement } from "@/lib/services/areaService";
import { clientIp, parseBody, requireRoot } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * FA-11.3, FA-11.4 — entitles a directory group to this area.
 *
 * The group is taken as a name and not validated against the directory. That
 * is NFR-04: the platform references groups, it does not synchronise them, and
 * a name that matches nothing today may match something tomorrow without
 * anybody coming back here.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ areaId: string }> },
): Promise<Response> {
  const session = await requireRoot(request);
  if (!session.ok) return toResponse(session);

  const body = await parseBody(request, createGroupEntitlementRequestSchema);
  if (!body.ok) return toResponse(body);

  const { areaId } = await params;
  return toResponse(
    await grantEntitlement(session.value, areaId, body.value, { sourceIp: clientIp(request) }),
    { status: 201 },
  );
}
