import type { z } from "zod";
import { uuidSchema } from "@scriptoria/contracts";
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

/**
 * A body that is allowed to be absent.
 *
 * ADR-003: a read-only script is stopped by the request itself, so the abort
 * request carries nothing at all — and an empty request is not a malformed one.
 * `request.json()` cannot tell those two apart, because a request with no body
 * still arrives as an empty *stream*: it throws, and a read-only abort comes
 * back as "the request body is not valid JSON" with the abort never attempted.
 * So the body is read as text, and a blank one is parsed as an empty object —
 * still through the schema, so a body that is required can still be refused.
 */
export async function parseOptionalBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<Result<z.infer<S>>> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return err("validation_failed", "The request body could not be read");
  }

  if (text.trim() === "") {
    const empty = schema.safeParse({});
    if (!empty.success) return validationFailed(empty.error.issues);
    return { ok: true, value: empty.data };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
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

/**
 * The ids a route's path carries, validated — the third of the three inputs a
 * handler takes, next to the body and the query.
 *
 * Every id in this API is a UUID, and a segment that is not one cannot name a
 * row: handed to Postgres it raises `22P02 invalid input syntax for type uuid`,
 * which arrived as a **500 with an empty body** — the error envelope broken, in
 * the one shape `packages/contracts` promises never happens, on routes any
 * signed-in account can reach with a typo.
 *
 * So a route validates its path the way it validates everything else for a
 * caller to fix:
 *
 * ```ts
 * const { runId } = await params;
 * const path = parsePath({ runId });
 * if (!path.ok) return toResponse(path);
 * ```
 */
export function parsePath<T extends Record<string, string>>(ids: T): Result<T> {
  for (const [name, value] of Object.entries(ids)) {
    if (!uuidSchema.safeParse(value).success) {
      return validationFailed([{ path: [name], message: "Must be a UUID" }]);
    }
  }
  return { ok: true, value: ids };
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
