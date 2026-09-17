import type { AreaSummary } from "@scriptoria/contracts";
import { areaRepository } from "@scriptoria/db";
import type { Session } from "../auth/session";
import { ok, type Result } from "../result";

/**
 * FA-03.1 and FA-03.6 — what the left navigation renders.
 *
 * The session's area set is the *only* input. It was built at login from the
 * groups the directory reported, matched against the mapping the root account
 * maintains (NFR-03), and nothing here widens it.
 *
 * An empty list is a valid answer and is returned as one: FA-01.4 is explicit
 * that an account in no entitled group sees nothing, and that this is an
 * outcome rather than an error. There is no 403 to return here — the user is
 * perfectly entitled to the nothing they can see.
 */
export async function listAreas(session: Session): Promise<Result<AreaSummary[]>> {
  return ok(await areaRepository.listAreaSummaries(session.areaIds));
}
