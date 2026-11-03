import { areaRepository, runRepository, scriptRepository } from "@scriptoria/db";
import type { Session } from "@/lib/auth/session";

/** A session as `readSession` would hand one to a route, without the Redis. */
export function session(over: Partial<Session> = {}): Session {
  return {
    id: "test-session",
    username: "admin.branch",
    displayName: "Branch Network Administrator",
    role: "administrator",
    groups: ["scriptoria-branch-network"],
    areaIds: [],
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    expiresAt: new Date(Date.now() + 3_600_000),
    ...over,
  };
}

/** An area with one mapped directory and one script in it. */
export async function seedArea(name: string) {
  const areaId = await areaRepository.createArea({
    name,
    description: `${name} for a test`,
    category: "one-off",
  });

  const sourceId = await areaRepository.addSource(areaId, {
    host: "script-vm.test",
    port: 22,
    username: "svc.scripts",
    scriptPath: "/opt/scriptoria/scripts",
    outputPath: "/opt/scriptoria/export",
  });

  await scriptRepository.replaceSourceScripts(areaId, sourceId, [
    {
      fileName: `${name.toLowerCase().replaceAll(" ", "-")}.sh`,
      absolutePath: `/opt/scriptoria/scripts/${name.toLowerCase().replaceAll(" ", "-")}.sh`,
      header: null,
      sizeBytes: 128,
      modifiedAt: new Date(),
    },
  ]);

  const [script] = await scriptRepository.listScriptsForArea(areaId);
  return { areaId, sourceId, scriptId: script!.id, fileName: script!.fileName };
}

export async function seedRun(area: Awaited<ReturnType<typeof seedArea>>, startedBy: string) {
  return runRepository.createRun({
    areaId: area.areaId,
    scriptId: area.scriptId,
    scriptFileName: area.fileName,
    scriptTitle: area.fileName,
    criticality: "read-only",
    host: "script-vm.test",
    outputPath: "/opt/scriptoria/export",
    startedBy,
    trigger: "manual",
    cols: 80,
    rows: 24,
  });
}
