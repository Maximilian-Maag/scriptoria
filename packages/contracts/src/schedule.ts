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
