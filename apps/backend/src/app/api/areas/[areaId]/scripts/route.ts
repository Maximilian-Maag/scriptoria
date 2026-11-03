import { listScripts, refresh } from "@/lib/services/catalogService";
import { parsePath, requireSession } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/** FA-03.3/3.4/3.5 — an area's scripts, each with the header it declares. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ areaId: string }> },
): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  const { areaId } = await params;
  const path = parsePath({ areaId });
  if (!path.ok) return toResponse(path);
  return toResponse(await listScripts(session.value, areaId));
}

/**
 * Rescans now, ignoring the cache. A POST because it has an effect on the
 * script VM's side of the connection, however small: it opens one.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ areaId: string }> },
): Promise<Response> {
  const session = await requireSession(request);
  if (!session.ok) return toResponse(session);

  const { areaId } = await params;
  const path = parsePath({ areaId });
  if (!path.ok) return toResponse(path);
  return toResponse(await refresh(session.value, areaId));
}
