import { createScriptSourceRequestSchema } from "@scriptoria/contracts";
import { addSource } from "@/lib/services/areaService";
import { clientIp, parseBody, requireRoot } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/** FA-11.2 — maps a directory on a script VM onto this area. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ areaId: string }> },
): Promise<Response> {
  const session = await requireRoot(request);
  if (!session.ok) return toResponse(session);

  const body = await parseBody(request, createScriptSourceRequestSchema);
  if (!body.ok) return toResponse(body);

  const { areaId } = await params;
  return toResponse(
    await addSource(session.value, areaId, body.value, { sourceIp: clientIp(request) }),
    { status: 201 },
  );
}
