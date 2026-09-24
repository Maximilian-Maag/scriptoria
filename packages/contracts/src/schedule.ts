import { z } from "zod";

/**
 * FA-10 / ADR-005. The crontab on the script VM is authoritative; these
 * schemas describe what the platform reads out of it and writes back into it.
 * There is no scheduler here — two schedulers would be two truths, and whatever
 * already watches the crontab hangs off the first one.
 */

/** Standard five-field cron. Validated properly in @scriptoria/core. */
export const cronExpressionSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((e) => e.split(/\s+/).length === 5, {
    message: "must have five fields: minute hour day-of-month month day-of-week",
  });

export const scheduleSchema = z.object({
  /** Derived from the crontab line, stable across reads of an unchanged file. */
  id: z.string(),
  areaId: z.string().uuid(),
  sourceId: z.string().uuid(),

  /** Null when the crontab line runs something outside the mapped script directory. */
  scriptId: z.string().uuid().nullable(),
  /** The command as it stands in the crontab, verbatim. */
  command: z.string(),

  expression: cronExpressionSchema,
  /** Human rendering of the expression, computed rather than stored. */
  expressionDescription: z.string(),

  /**
   * True when this line sits inside the platform's delimited block. Lines
   * outside it are shown but not edited — ADR-005 leaves them byte-for-byte
   * intact.
   */
  managed: z.boolean(),
  enabled: z.boolean(),

  /**
   * O-1: reduced to *last successful*, which is what the usability of the result
   * hangs on. The platform does not see a cron run happen, only what it left
   * behind, so these come from run records for platform-started runs and from
   * the output directory for cron-started ones.
   */
  lastSuccessfulAt: z.string().datetime({ offset: true }).nullable(),
  lastRunAt: z.string().datetime({ offset: true }).nullable(),
  nextRunAt: z.string().datetime({ offset: true }).nullable(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

/** FA-10.4. Only the expression and the enabled flag — never the command. */
export const updateScheduleRequestSchema = z.object({
  expression: cronExpressionSchema.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateScheduleRequest = z.infer<typeof updateScheduleRequestSchema>;

/**
 * FA-10.1 — a schedule's id, which is *derived* rather than stored.
 *
 * ADR-005 makes the crontab on the script VM the truth, so a scheduled line has
 * no row to hang an id on. `scheduleId()` in `@scriptoria/core` hashes the
 * source, the command and the line's occurrence into **eight hex characters**,
 * so that a line's identity survives being read out of the file and written
 * back into it — and survives an edit to its expression, which is the whole
 * point of keying on the command.
 *
 * It is therefore not a UUID and never was. A route that validates it as one
 * refuses every request it exists to serve (#73): saving a schedule answered
 * `validation_failed` / "The request body is not valid" and named the wrong
 * input, because the body was the one thing that was right.
 *
 * The declared shape is asserted against the generator in
 * `apps/backend/test/http.test.ts`, so the two cannot drift apart again.
 */
export const scheduleIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}$/, "Must be an eight-character schedule id, like 8069ac6e");
export type ScheduleId = z.infer<typeof scheduleIdSchema>;
