import { db } from "@scriptoria/db";
import { redis } from "@/lib/redis";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * NFR-16 — the monitoring system polls this. The platform raises no alerts of
 * its own, so
 * this endpoint's job is to be accurate rather than reassuring: it reports what
 * it actually checked, and a degraded dependency is a 503.
 */
export async function GET(): Promise<Response> {
  const checks: Record<string, "ok" | "failed"> = {};

  try {
    await db().execute(sql`select 1`);
    checks["database"] = "ok";
  } catch {
    checks["database"] = "failed";
  }

  try {
    await redis().ping();
    checks["redis"] = "ok";
  } catch {
    checks["redis"] = "failed";
  }

  const healthy = Object.values(checks).every((state) => state === "ok");
  return Response.json(
    { status: healthy ? "ok" : "degraded", checks },
    { status: healthy ? 200 : 503 },
  );
}
