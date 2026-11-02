import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptRepository } from "@scriptoria/db";
import type { Session } from "../src/lib/auth/session";

/**
 * FA-03.3. A script that has gone from the script VM is kept in the catalog —
 * its run history references it and FA-12 wants that history readable — but it is
 * not a thing to run.
 *
 * The repository's I/O is mocked here and its presence rule is not: the rule
 * under test is the one the real `isPresent` applies to a real row, and mocking it
 * away is how a test ends up asserting its own fixture.
 */

// `vi.mock` is hoisted above the imports, so the spies have to be created in a
// hoisted block as well.
const { findScriptInAreas, createRun, record } = vi.hoisted(() => ({
  findScriptInAreas: vi.fn(),
  createRun: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@scriptoria/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scriptoria/db")>();
  return {
    ...actual,
    scriptRepository: { ...actual.scriptRepository, findScriptInAreas },
    runRepository: { ...actual.runRepository, createRun },
    auditRepository: { ...actual.auditRepository, record },
  };
});

vi.mock("../src/lib/redis", () => ({
  keys: { runQueue: "scriptoria:run:queue" },
  redis: () => ({ lpush: vi.fn() }),
}));

const { startRun } = await import("../src/lib/services/runService");

const SCANNED_AT = new Date("2026-09-21T10:00:00.000Z");
const EARLIER_SCAN = new Date("2026-09-20T10:00:00.000Z");

const SESSION: Session = {
  id: "session-id",
  username: "admin.branch",
  displayName: "Branch Admin",
  role: "administrator",
  groups: [],
  areaIds: ["area-1"],
  createdAt: SCANNED_AT.getTime(),
  lastSeenAt: SCANNED_AT.getTime(),
  expiresAt: new Date(SCANNED_AT.getTime() + 3_600_000),
};

function row(presentAt: Date) {
  return {
    script: {
      id: "11111111-1111-4111-8111-111111111111",
      areaId: "area-1",
      sourceId: "22222222-2222-4222-8222-222222222222",
      fileName: "nightly.sh",
      absolutePath: "/opt/scriptoria/scripts/nightly.sh",
      header: null,
      criticalityOverride: null,
      sizeBytes: 10,
      modifiedAt: EARLIER_SCAN,
      presentAt,
      scannedAt: SCANNED_AT,
    },
    source: {
      host: "vm1.example.test",
      port: 22,
      username: "scriptoria",
      outputPath: "/opt/scriptoria/export",
    },
  };
}

beforeEach(() => {
  findScriptInAreas.mockReset();
  createRun.mockReset();
  record.mockReset();
  createRun.mockResolvedValue({ id: "run-1", queuedAt: SCANNED_AT });
});

describe("the presence rule itself", () => {
  it("calls a row the newest scan found present", () => {
    // `replaceSourceScripts` stamps both from the same instant, so presence is
    // exactly this agreement.
    expect(scriptRepository.isPresent({ presentAt: SCANNED_AT, scannedAt: SCANNED_AT })).toBe(true);
  });

  it("calls a row the newest scan did not find vanished", () => {
    expect(scriptRepository.isPresent({ presentAt: EARLIER_SCAN, scannedAt: SCANNED_AT })).toBe(
      false,
    );
  });
});

describe("startRun", () => {
  it("refuses a script the newest scan did not find", async () => {
    findScriptInAreas.mockResolvedValue(row(EARLIER_SCAN));

    const result = await startRun(
      SESSION,
      { scriptId: "11111111-1111-4111-8111-111111111111" },
      { sourceIp: null },
    );

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    // Nothing was queued, so no worker can open a PTY to a path that is not there.
    expect(createRun).not.toHaveBeenCalled();
  });

  it("starts a script the newest scan did find", async () => {
    findScriptInAreas.mockResolvedValue(row(SCANNED_AT));

    const result = await startRun(
      SESSION,
      { scriptId: "11111111-1111-4111-8111-111111111111" },
      { sourceIp: null },
    );

    expect(result).toMatchObject({ ok: true });
    expect(createRun).toHaveBeenCalledTimes(1);
  });
});
