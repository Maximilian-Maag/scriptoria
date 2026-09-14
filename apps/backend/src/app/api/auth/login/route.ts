import { loginRequestSchema } from "@scriptoria/contracts";
import { login } from "@/lib/services/authService";
import { clientIp, parseBody } from "@/lib/http";
import { sessionCookie } from "@/lib/auth/session";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = await parseBody(request, loginRequestSchema);
  if (!body.ok) return toResponse(body);

  const result = await login(body.value, { sourceIp: clientIp(request) });
  if (!result.ok) return toResponse(result);

  const response = toResponse({ ok: true as const, value: { user: result.value.user } });
  // The id goes into an httpOnly cookie and nowhere else. The response body
  // carries the user, never the session.
  response.headers.append("set-cookie", sessionCookie(result.value.session.id));
  return response;
}
