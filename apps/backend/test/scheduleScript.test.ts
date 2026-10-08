import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/lib/auth/session";

/**
 * FA-10.3 — which script a crontab line runs, so the interface can offer that
 * script's own *Run now*.
 *
 * A scheduled line has no row of its own (ADR-005: the crontab is the truth),
 * so `listSchedules` answers the question by looking for a catalogued script
 * whose path the command refers to. The lookup has to be on a *path boundary*:
 * a command that runs
 *
 *     /opt/scriptoria/scripts/deploy.sh.in
 *
 * names `deploy.sh.in`, and a plain `command.includes(absolutePath)` matches
 * the shorter `deploy.sh` first — because the catalog is ordered by file name
 * and `deploy.sh` sorts before `deploy.sh.in`. The schedule is then attributed
 * to the wrong script, and *Run now* starts it: a `.in`/`.bak`/`.old` sibling of
 * a script is a common thing to keep next to one on a real script directory, so
 * the wrong script is started rather than the one whose schedule was clicked.
 *
 * The repositories are mocked and the matching rule is not: a crontab is read
 * through the runner's client (mocked to return known text) and the catalog is
 * whatever the scan would have produced.
 */

const { listSourcesForAreas, listScriptsForArea, lastSuccessfulByScript, readCrontab } = vi.hoisted(
  () => ({
    listSourcesForAreas: vi.fn(),
    listScriptsForArea: vi.fn(),
    lastSuccessfulByScript: vi.fn(),
    readCrontab: vi.fn(),
  }),
);

vi.mock("@scriptoria/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scriptoria/db")>();
  return {
    ...actual,
    areaRepository: { ...actual.areaRepository, listSourcesForAreas },
    scriptRepository: { ...actual.scriptRepository, listScriptsForArea },
    runRepository: { ...actual.runRepository, lastSuccessfulByScript },
  };
});

vi.mock("../src/lib/runner/client", () => ({ readCrontab }));

const { listSchedules } = await import("../src/lib/services/scheduleService");

const AREA_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";

const SESSION: Session = {
  id: "session-1",
  username: "admin.branch",
  displayName: "Branch Admin",
  role: "administrator",
  groups: ["scriptoria-branch-network"],
  areaIds: [AREA_ID],
  createdAt: 0,
  lastSeenAt: 0,
  expiresAt: new Date(3_600_000),
};

interface ScriptStub {
  id: string;
  fileName: string;
  absolutePath: string;
}

const script = (id: string, fileName: string, absolutePath: string) => ({
  id,
  areaId: AREA_ID,
  sourceId: SOURCE_ID,
  fileName,
  absolutePath,
  title: fileName,
  description: "",
  criticality: "read-only" as const,
  criticalityOverridden: false,
  interactive: false,
  outputPath: "/opt/scriptoria/export",
  header: null,
  sizeBytes: 10,
  modifiedAt: null,
  scannedAt: "2026-03-04T09:00:00.000Z",
  present: true,
});

beforeEach(() => {
  listSourcesForAreas.mockReset();
  listScriptsForArea.mockReset();
  lastSuccessfulByScript.mockReset();
  readCrontab.mockReset();

  listSourcesForAreas.mockResolvedValue([
    {
      id: SOURCE_ID,
      areaId: AREA_ID,
      host: "vm1.example.test",
      port: 22,
      username: "scriptoria",
      scriptPath: "/opt/scriptoria/scripts",
      outputPath: "/opt/scriptoria/export",
    },
  ]);
  lastSuccessfulByScript.mockResolvedValue(new Map());
});

const scheduleFor = async (command: string, scripts: ScriptStub[]) => {
  readCrontab.mockResolvedValue({ ok: true, value: `0 3 * * * ${command}\n` });
  listScriptsForArea.mockResolvedValue(scripts);

  const result = await listSchedules(SESSION, { areaId: AREA_ID });
  if (!result.ok) throw new Error(`listing refused: ${result.message}`);
  return result.value;
};

describe("the script a schedule runs (FA-10.3)", () => {
  it("attributes a command to the script it names, not to a shorter neighbour", async () => {
    // Ordered the way `listScriptsForArea` orders: by file name, so the shorter
    // `deploy.sh` comes first and wins a plain substring match.
    const shorter = script("aaaaaaaa-1111-4111-8111-111111111111", "deploy.sh", "/opt/scriptoria/scripts/deploy.sh");
    const longer = script("bbbbbbbb-2222-4222-8222-222222222222", "deploy.sh.in", "/opt/scriptoria/scripts/deploy.sh.in");

    const schedules = await scheduleFor("/opt/scriptoria/scripts/deploy.sh.in", [shorter, longer]);

    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.command).toBe("/opt/scriptoria/scripts/deploy.sh.in");
    expect(schedules[0]?.scriptId).toBe(longer.id);
  });

  it("still finds a script when the command carries arguments and a redirect", async () => {
    const report = script("cccccccc-3333-4333-8333-333333333333", "report.sh", "/opt/scriptoria/scripts/report.sh");

    const schedules = await scheduleFor(
      "/opt/scriptoria/scripts/report.sh >> /opt/scriptoria/export/report.log 2>&1",
      [report],
    );

    expect(schedules[0]?.scriptId).toBe(report.id);
  });

  it("leaves a command that runs something outside the mapped directory unattributed", async () => {
    const report = script("cccccccc-3333-4333-8333-333333333333", "report.sh", "/opt/scriptoria/scripts/report.sh");

    const schedules = await scheduleFor("/usr/local/bin/some-other-thing.sh", [report]);

    expect(schedules[0]?.scriptId).toBeNull();
  });
});
