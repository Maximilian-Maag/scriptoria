import { sql } from "drizzle-orm";
import { closeDb, db, schema } from "./client";
import { loadEnvFile } from "@scriptoria/config";

loadEnvFile();

/**
 * The minimum a fresh database needs to be usable: the root group mapping, and
 * the reference area pointing at the sshd fixture.
 *
 * Without the root group nobody can reach administration, and without
 * administration nobody can map anything — so a brand-new database would be a
 * platform that is functionless and offers no way to stop being functionless.
 * That is the one bootstrap problem worth solving in a seed script.
 *
 * Idempotent: running it twice changes nothing.
 */

const ROOT_GROUP = process.env["SEED_ROOT_GROUP"] ?? "scriptoria-root";

async function seed(): Promise<void> {
  await db()
    .insert(schema.rootGroups)
    .values({ directoryGroup: ROOT_GROUP })
    .onConflictDoNothing();
  console.log(`root group: ${ROOT_GROUP}`);

  // The reference area, against the dev sshd fixture. In a real deployment the
  // root account creates these through the interface; here it exists so that
  // `make dev` produces something a person can log into and see.
  const existing = await db().query.areas.findFirst({
    where: sql`${schema.areas.name} = 'Branch Network'`,
  });

  if (existing) {
    console.log("reference area already present");
    return;
  }

  const [area] = await db()
    .insert(schema.areas)
    .values({
      name: "Branch Network",
      description:
        "Reference area against the sshd fixture, standing in for the script VM until a real one is mapped.",
      category: "one-off",
    })
    .returning({ id: schema.areas.id });

  await db().insert(schema.scriptSources).values({
    areaId: area!.id,
    host: process.env["SEED_SSH_HOST"] ?? "localhost",
    port: Number(process.env["SEED_SSH_PORT"] ?? 2222),
    username: "svc.scripts",
    scriptPath: "/opt/scriptoria/scripts",
    outputPath: "/opt/scriptoria/export",
  });

  // Matches cn=scriptoria-branch-network in the directory fixture, so admin.branch
  // sees this area and admin.none sees nothing — which is FA-01.4, end to end.
  await db().insert(schema.areaEntitlements).values({
    areaId: area!.id,
    directoryGroup: "scriptoria-branch-network",
  });

  console.log("reference area created: Branch Network → localhost:2222 /opt/scriptoria/scripts");
}

try {
  await seed();
} finally {
  await closeDb();
}
