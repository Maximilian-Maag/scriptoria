import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { AuditAction, AuditEntry, AuditQuery } from "@scriptoria/contracts";
import { db, schema } from "../client";

/**
 * FA-12. Every write here is a fact about something that already happened, so
 * nothing in this module ever fails a caller: an audit write that throws must
 * not be able to roll back the run it was recording.
 */

export interface AuditInput {
  actor: string;
  action: AuditAction;
  subject?: string;
  areaId?: string | null;
  runId?: string | null;
  outcome?: "success" | "failure";
  detail?: Record<string, unknown>;
  sourceIp?: string | null;
}

export async function record(input: AuditInput): Promise<void> {
  try {
    await db()
      .insert(schema.auditLog)
      .values({
        actor: input.actor,
        action: input.action,
        subject: input.subject ?? "",
        areaId: input.areaId ?? null,
        runId: input.runId ?? null,
        outcome: input.outcome ?? "success",
        detail: input.detail ?? {},
        sourceIp: input.sourceIp ?? null,
      });
  } catch (cause) {
    // The SIEM still gets the line. Losing the database copy of an audit record
    // is bad; letting it abort the operation being audited is worse.
    console.error("audit write failed", { action: input.action, actor: input.actor, cause });
  }
}

export async function query(
  filter: AuditQuery,
): Promise<{ items: AuditEntry[]; total: number }> {
  const conditions: SQL[] = [];
  if (filter.actor) conditions.push(eq(schema.auditLog.actor, filter.actor));
  if (filter.action) conditions.push(eq(schema.auditLog.action, filter.action));
  if (filter.areaId) conditions.push(eq(schema.auditLog.areaId, filter.areaId));
  if (filter.runId) conditions.push(eq(schema.auditLog.runId, filter.runId));
  if (filter.from) conditions.push(gte(schema.auditLog.at, new Date(filter.from)));
  if (filter.to) conditions.push(lte(schema.auditLog.at, new Date(filter.to)));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [counted]] = await Promise.all([
    db()
      .select()
      .from(schema.auditLog)
      .where(where)
      .orderBy(desc(schema.auditLog.at))
      .limit(filter.limit)
      .offset(filter.offset),
    db()
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(where),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      actor: row.actor,
      action: row.action as AuditAction,
      subject: row.subject,
      areaId: row.areaId,
      runId: row.runId,
      outcome: row.outcome,
      detail: row.detail,
      sourceIp: row.sourceIp,
    })),
    total: counted?.total ?? 0,
  };
}
