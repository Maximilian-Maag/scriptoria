import { updateScheduleRequestSchema } from "@scriptoria/contracts";
import { updateSchedule } from "@/lib/services/scheduleService";
import { clientIp, parseBody, parsePath, requireRoot } from "@/lib/http";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * FA-10.4 — the root account changes a schedule without shell access.
 *
 * Root only, like the rest of platform administration: FA-11 makes maintaining
 * recurring jobs root's job, and the reason is the same one that puts area
 * mapping there. A schedule decides what happens on hundreds of systems at
 * three in the morning with nobody watching.
 *
 * Only the expression and the enabled flag. The command is not editable through
 * this route and never should be — a route that wrote arbitrary crontab
 * commands would be a remote shell wearing a scheduler's clothes.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ scheduleId: string }> },
): Promise<Response> {
  const session = await requireRoot(request);
  if (!session.ok) return toResponse(session);

  const body = await parseBody(request, updateScheduleRequestSchema);
  if (!body.ok) return toResponse(body);

  const { scheduleId } = await params;
  const path = parsePath({ scheduleId });
  if (!path.ok) return toResponse(path);
  return toResponse(
    await updateSchedule(session.value, scheduleId, body.value, { sourceIp: clientIp(request) }),
  );
}
