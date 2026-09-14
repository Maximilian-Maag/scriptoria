import type { SessionResponse } from "@scriptoria/contracts";
import { readSession } from "@/lib/auth/session";
import { sessionIdFrom } from "@/lib/http";
import { toSessionUser } from "@/lib/services/authService";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * Who am I. Returns `{ user: null }` with a 200 rather than a 401, because the
 * frontend calls this to decide whether to render the login form — and a 401 in
 * the browser console on every first page load trains people to ignore 401s.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await readSession(sessionIdFrom(request));
  const body: SessionResponse = { user: session ? toSessionUser(session) : null };
  return toResponse({ ok: true as const, value: body });
}
