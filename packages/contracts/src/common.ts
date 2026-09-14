import { z } from "zod";

/**
 * The vocabulary every other schema is built from.
 *
 * These schemas are the contract between the frontend, the backend and the
 * runner, and they are also what the OpenAPI document is generated from — so a
 * route cannot accept something the published contract does not describe. That
 * is the entire reason this package exists (ADR-002).
 */

export const uuidSchema = z.string().uuid();

/**
 * A path on the script VM. Not a path on this machine — nothing here is ever
 * opened locally. The rejection of `..` is not path traversal defence (the
 * runner never joins these against anything), it is a sanity check on admin
 * input: a mapped script directory containing `..` is a typo, not an intention.
 */
export const remotePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith("/"), { message: "must be an absolute path" })
  .refine((p) => !p.split("/").includes(".."), { message: "must not contain '..'" });

/** A single path segment: a file name inside a result directory. */
export const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((n) => !n.includes("/") && n !== "." && n !== "..", {
    message: "must be a single file name",
  });

export const isoDateTimeSchema = z.string().datetime({ offset: true });

/**
 * The error envelope. Every non-2xx response from the backend is exactly this
 * shape, because the frontend has one error renderer and mapping N shapes into
 * it is how a UI ends up showing "[object Object]" to an operator.
 */
export const errorCodeSchema = z.enum([
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "validation_failed",
  "upstream_unavailable",
  "timeout",
  "internal",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    /** Written for the person reading it, not for a log grep. */
    message: z.string(),
    /** Field-level detail for `validation_failed`; absent otherwise. */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
  });
