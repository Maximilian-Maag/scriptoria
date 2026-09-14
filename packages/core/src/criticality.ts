import type { Criticality, ScriptHeader } from "@scriptoria/contracts";

/**
 * ADR-003 and ADR-004, in the one place where they meet: what a script's
 * criticality actually is, and what that means when somebody tries to stop it.
 *
 * This is deliberately pure and deliberately tiny. Getting it wrong means a
 * script that modifies hundreds of systems is stopped halfway with no warning,
 * or is not stopped when somebody meant to stop it. A rule carrying that much
 * weight should be readable in one screen and testable without a database.
 */

/**
 * The admin's override wins over the header, the header wins over nothing, and
 * nothing means `unknown`.
 *
 * The precedence is this way round so that a script owner who has not yet
 * annotated their scripts does not block the rollout, and so that a wrong
 * declaration can be corrected without editing a production script.
 */
export function effectiveCriticality(
  override: Criticality | null | undefined,
  header: ScriptHeader | null | undefined,
): Criticality {
  if (override) return override;
  return header?.criticality ?? "unknown";
}

/**
 * `unknown` is treated as `modifying`. The cost of wrongly warning about a
 * read-only script is an extra click; the cost of the reverse is an unannounced
 * change to every system the script touches.
 */
export function isModifying(criticality: Criticality): boolean {
  return criticality !== "read-only";
}

/** FA-08.3: a read-only script aborts immediately, everything else is confirmed. */
export function requiresAbortConfirmation(criticality: Criticality): boolean {
  return isModifying(criticality);
}

export type AbortAuthorisation =
  | { ok: true }
  | { ok: false; reason: "confirmation_required" | "confirmation_mismatch" };

/**
 * Checks the confirmation FA-08.3 requires. The confirmation names the script,
 * rather than being a yes/no box, because the thing being prevented is stopping
 * the *wrong* run out of a list — and a yes/no box does not prevent that.
 */
export function authoriseAbort(
  criticality: Criticality,
  scriptFileName: string,
  confirmation: string | undefined,
): AbortAuthorisation {
  if (!requiresAbortConfirmation(criticality)) return { ok: true };
  if (confirmation === undefined || confirmation.trim() === "") {
    return { ok: false, reason: "confirmation_required" };
  }
  if (confirmation.trim() !== scriptFileName.trim()) {
    return { ok: false, reason: "confirmation_mismatch" };
  }
  return { ok: true };
}
