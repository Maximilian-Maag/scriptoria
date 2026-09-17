import type { AuditEntry, AuditQuery } from "@scriptoria/contracts";
import { auditRepository } from "@scriptoria/db";
import { ok, type Result } from "../result";

/**
 * FA-12's read. Everything else in the product *writes* the audit log as a side
 * effect of doing something; this is the one module that reads it back.
 *
 * It takes no session, exactly as `listAllAreas` does and for the same reason:
 * the route above it is `requireRoot`, and an audit log filtered by the reader's
 * own entitlements is not an audit log. The roles table gives an administrator
 * the areas, scripts, runs and results their groups reach (FA-02.4) and nothing
 * beyond that — reading who did what across the platform is not among their
 * rights, and root is where it belongs.
 *
 * Nothing here interprets an entry. A record is returned as it was written,
 * including a `detail` blob whose shape depends on the action, because the value
 * of an audit trail is that it says what happened rather than what a later
 * version of this code thinks happened.
 */
export async function queryAuditLog(
  filter: AuditQuery,
): Promise<Result<{ items: AuditEntry[]; total: number; limit: number; offset: number }>> {
  const { items, total } = await auditRepository.query(filter);
  return ok({ items, total, limit: filter.limit, offset: filter.offset });
}
