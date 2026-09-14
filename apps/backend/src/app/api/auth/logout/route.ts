import { logout } from "@/lib/services/authService";
import { sessionIdFrom } from "@/lib/http";
import { clearedSessionCookie } from "@/lib/auth/session";
import { toResponse } from "@/lib/result";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const id = sessionIdFrom(request);
  // Logging out without a session is a success. The desired end state — no
  // session — is the state the caller is already in.
  if (id) await logout(id);

  const response = toResponse({ ok: true as const, value: null });
  response.headers.append("set-cookie", clearedSessionCookie());
  return response;
}
