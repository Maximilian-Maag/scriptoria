import { type ApiError, type ErrorCode } from "@scriptoria/contracts";

/**
 * `Result<T>` and the one place it becomes an HTTP response.
 *
 * Services return this; they never construct a `Response` and they never throw
 * for anything a caller could have caused. Two reasons, and the second is the
 * one that matters:
 *
 *   · A thrown error carries no contract. `Result` makes every failure a route
 *     can produce visible in the service's signature.
 *   · An unauthorised access and a missing row must be indistinguishable to the
 *     caller in some cases and distinguishable in others, and that decision
 *     belongs in one function rather than in forty `catch` blocks.
 */

export type Ok<T> = { ok: true; value: T };
export type Err = {
  ok: false;
  code: ErrorCode;
  message: string;
  details?: { path: string; message: string }[];
  /** Logged, never sent. The client gets `message`; the operator gets this. */
  cause?: unknown;
};

export type Result<T> = Ok<T> | Err;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export const err = (
  code: ErrorCode,
  message: string,
  options?: { details?: { path: string; message: string }[]; cause?: unknown },
): Err => ({
  ok: false,
  code,
  message,
  ...(options?.details ? { details: options.details } : {}),
  ...(options?.cause !== undefined ? { cause: options.cause } : {}),
});

/** Shorthands for the failures that come up in nearly every service. */
export const unauthenticated = (message = "Not signed in") => err("unauthenticated", message);
export const forbidden = (message = "Not entitled for this area") => err("forbidden", message);
export const notFound = (message = "Not found") => err("not_found", message);
export const conflict = (message: string) => err("conflict", message);
export const internal = (message: string, cause?: unknown) =>
  err("internal", message, cause === undefined ? undefined : { cause });

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  upstream_unavailable: 502,
  timeout: 504,
  internal: 500,
};

export const statusFor = (code: ErrorCode): number => STATUS[code];

/**
 * The only function in the codebase that turns a domain outcome into a wire
 * response. A route handler is `validate → service → toResponse` and nothing
 * else; anything that needs more than that has logic in the wrong place.
 */
export function toResponse<T>(result: Result<T>, init?: { status?: number }): Response {
  if (result.ok) {
    if (result.value === undefined || result.value === null) {
      return new Response(null, { status: init?.status ?? 204 });
    }
    return Response.json(result.value, { status: init?.status ?? 200 });
  }

  const body: ApiError = {
    error: {
      code: result.code,
      message: result.message,
      ...(result.details ? { details: result.details } : {}),
    },
  };
  return Response.json(body, { status: statusFor(result.code) });
}

/** Maps a Zod failure onto the error envelope, field paths intact. */
export function validationFailed(issues: readonly { path: PropertyKey[]; message: string }[]): Err {
  return err("validation_failed", "The request body is not valid", {
    details: issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  });
}
