import parser from "cron-parser";
import cronstrue from "cronstrue";

/**
 * *Next use* for a recurring script (FA-10.2), computed from the cron expression
 * rather than stored. ADR-005: the crontab is the truth, so anything derivable
 * from it is derived, not cached — a schedule edited outside the platform is
 * then picked up automatically instead of quietly disagreeing.
 */

export interface CronValidation {
  valid: boolean;
  /** Human-readable, for the schedule list. Empty when the expression is invalid. */
  description: string;
  error?: string;
}

/**
 * The script VM's own timezone is what a crontab entry means, not the browser's
 * and not the control plane's — a schedule shown in the wrong zone is a schedule
 * somebody will set an hour wrong.
 *
 * UTC is the default because it is the only choice that is wrong in the same way
 * everywhere. Deployments whose script VM runs on local time should pass the
 * VM's zone explicitly rather than rely on this.
 */
export const DEFAULT_CRON_TIMEZONE = "UTC";

export function validateCronExpression(expression: string): CronValidation {
  try {
    parser.parseExpression(expression);
  } catch (error) {
    return {
      valid: false,
      description: "",
      error: error instanceof Error ? error.message : "invalid cron expression",
    };
  }

  let description = expression;
  try {
    description = cronstrue.toString(expression, { verbose: false });
  } catch {
    // A parseable expression that cronstrue cannot phrase is still a valid
    // schedule. Showing the raw expression is worse than a sentence and far
    // better than an error.
  }
  return { valid: true, description };
}

export function nextRunAt(
  expression: string,
  options?: { from?: Date; timezone?: string },
): Date | null {
  try {
    const interval = parser.parseExpression(expression, {
      currentDate: options?.from ?? new Date(),
      tz: options?.timezone ?? DEFAULT_CRON_TIMEZONE,
    });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/**
 * A stable identity for a crontab line, so that the schedule an admin edited is
 * still the same schedule after the file has been read again.
 *
 * Keyed on the command rather than on the expression, because editing the
 * expression is precisely the operation that must not change the identity.
 *
 * `occurrence` disambiguates the case the fixture crontab actually contains: the
 * same command scheduled twice at different times — once by hand and once inside
 * the managed block. Command alone would give those two lines one id, and the
 * interface would then offer to edit one line and edit the other. It is the
 * *nth line with this command*, not the nth line overall, so adding an unrelated
 * job above does not renumber anything; and since an edit changes neither the
 * command nor its ordinal, identity still survives the edit.
 */
export function scheduleId(sourceId: string, command: string, occurrence = 0): string {
  const input = `${sourceId}::${command.trim()}::${occurrence}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
