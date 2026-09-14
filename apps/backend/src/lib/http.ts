import type { z } from "zod";
import { readSession, type Session } from "./auth/session";
import { err, forbidden, unauthenticated, validationFailed, type Result } from "./result";
import { loadBackendConfig } from "@scriptoria/config";

/**
 * The four things a route handler is allowed to do before it calls a service.
 *
 * A route handler in this codebase is `validate → service → toResponse`. If one
 * grows a fifth step, the step belongs in a service — the point of keeping the
 * handlers this thin is that the authorisation checks are all in one shape and
 * can be read in one sitting.
 */

export async function parseBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<Result<z.infer<S>>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("validation_failed", "The request body is not valid JSON");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return validationFailed(parsed.error.issues);
  return { ok: true, value: parsed.data };
}

export function parseQuery<S extends z.ZodTypeAny>(request: Request, schema: S): Result<z.infer<S>> {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) return validationFailed(parsed.error.issues);
  return { ok: true, value: parsed.data };
}

export function sessionIdFrom(request: Request): string | undefined {
  const name = loadBackendConfig().SESSION_COOKIE_NAME;
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      const value = rest.join("=");
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

export async function requireSession(request: Request): Promise<Result<Session>> {
  const session = await readSession(sessionIdFrom(request));
  if (!session) return unauthenticated();
  return { ok: true, value: session };
}

/** Platform administration — areas, entitlements, schedules — is root only. */
export async function requireRoot(request: Request): Promise<Result<Session>> {
  const session = await requireSession(request);
  if (!session.ok) return session;
  if (session.value.role !== "root") {
    return forbidden("Managing the platform requires the root account");
  }
  return session;
}

/**
 * FA-12.1's "where". Read from the proxy header, because in a real deployment
 * every request arrives through a reverse proxy and the socket address is
 * always that proxy.
 */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return request.headers.get("x-real-ip");
}
