import postgres from "postgres";

/**
 * The audit trail, read as it is written.
 *
 * FA-12 makes the audit log a *record* — who started what, where, when, with
 * what outcome — and the product deliberately has no screen for it and no
 * endpoint that serves it: it is an operational artifact, read with the tools an
 * operator already has. Which leaves the suite two options, and only one of them
 * is honest. Asserting it through the interface is impossible; asserting it
 * through a *second* API would test a reader rather than the record. So this
 * reads the table the application writes.
 *
 * It reads the database the *suite* is told the application uses, and asks for
 * no fallback of its own: if the two disagree the spec fails on an empty result,
 * which is the right way to find out that the tests and the application are
 * pointed at different places.
 */

export interface AuditRow {
  at: Date;
  actor: string;
  action: string;
  subject: string;
  areaId: string | null;
  runId: string | null;
  outcome: "success" | "failure";
  detail: Record<string, unknown>;
  sourceIp: string | null;
}

let client: postgres.Sql | null = null;

/** Opened on first use, so a spec that needs no audit rows pays nothing. */
export function auditDb(): postgres.Sql {
  if (client) return client;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set, so the audit trail cannot be read. The suite reads the " +
        "same database the application writes — point it at the one the stack under test uses.",
    );
  }

  client = postgres(url, { max: 1, onnotice: () => {} });
  return client;
}

export async function closeAuditDb(): Promise<void> {
  if (!client) return;
  await client.end();
  client = null;
}

/** Rows for one actor and action, newest first. */
export async function auditRows(filter: {
  action?: string;
  actor?: string;
  runId?: string;
  subject?: string;
}): Promise<AuditRow[]> {
  const sql = auditDb();
  return sql<AuditRow[]>`
    select at, actor, action, subject,
           area_id as "areaId", run_id as "runId",
           outcome, detail, source_ip as "sourceIp"
    from audit_log
    where true
      ${filter.action === undefined ? sql`` : sql`and action = ${filter.action}`}
      ${filter.actor === undefined ? sql`` : sql`and actor = ${filter.actor}`}
      ${filter.runId === undefined ? sql`` : sql`and run_id = ${filter.runId}`}
      ${filter.subject === undefined ? sql`` : sql`and subject = ${filter.subject}`}
    order by at desc
  `;
}

/**
 * Rows that may not be there yet.
 *
 * Two of the actions the suite asserts are written by processes other than the
 * one that answered the browser: the runner records what a run did. Waiting is
 * therefore part of reading them, and the poll is bounded so a missing row is a
 * failure rather than a hang.
 */
export async function waitForAuditRow(
  filter: Parameters<typeof auditRows>[0],
  timeoutMs = 20_000,
): Promise<AuditRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await auditRows(filter);
    const row = rows[0];
    if (row) return row;
    if (Date.now() > deadline) {
      throw new Error(
        `no audit row for ${JSON.stringify(filter)} after ${timeoutMs}ms — the record FA-12 asks for was not written`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
