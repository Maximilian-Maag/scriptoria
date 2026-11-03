/**
 * The database's own failures, named here so that nothing above this package
 * has to know a Postgres error code to tell "somebody already took that name"
 * apart from "the database is down".
 *
 * Catching the constraint violation is deliberate, rather than checking for a
 * duplicate first and then inserting. That check-then-act has a race between
 * the two statements, and under it two administrators creating the same area
 * name at the same time both see their check pass. The unique index is what
 * actually makes the invariant true; this just reads the answer it gives.
 */

/** Postgres class 23 — integrity constraint violation. */
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const codeOf = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : undefined;

export const isUniqueViolation = (cause: unknown): boolean => codeOf(cause) === UNIQUE_VIOLATION;

export const isForeignKeyViolation = (cause: unknown): boolean =>
  codeOf(cause) === FOREIGN_KEY_VIOLATION;
