import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/lib/auth/session";

/**
 * FA-08.1 / ADR-003 — stopping a run that has not started.
 *
 * Three things have to line up for an abort to work, and for a `queued` run none
 * of them did (#50): the request was published to a control channel nobody was
 * subscribed to, `recordAbortRequest` wrote two columns nothing read, and the
 * status gate let a `queued` run straight through. The interface and the audit
 * trail both said the run had been stopped; the run then started anyway, and on
 * a **modifying** script that means it ran across the estate.
 *
 * A queued run is not a run to signal, it is a run to cancel — and the worker's
 * claim is what decides the race, which is why the transition's guard is the
 * thing under test here rather than a `publish` that cannot arrive.
 *
 * The repositories and Redis are mocked; the authorisation rule is not, because
 * the order of the check is half of what this file asserts.
 */

// `vi.mock` is hoisted above the imports, so the spies have to be created in a
// hoisted block as well.
const { getRun, transition, appendEvent, recordAbortRequest, publish, record } = vi.hoisted(() => ({
  getRun: vi.fn(),
  transition: vi.fn(),
  appendEvent: vi.fn(),
  recordAbortRequest: vi.fn(),
  publish: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@scriptoria/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scriptoria/db")>();
  return {
    ...actual,
    runRepository: {
      ...actual.runRepository,
      getRun,
      transition,
      appendEvent,
      recordAbortRequest,
    },
    auditRepository: { ...actual.auditRepository, record },
  };
});

vi.mock("../src/lib/redis", () => ({
  keys: { runClaim: (id: string) => `scriptoria:run:${id}:claim` },
  redis: () => ({ publish }),
}));

const { abortRun } = await import("../src/lib/services/runService");

const SESSION: Session = {
  id: "session-id",
  username: "admin.branch",
  displayName: "Branch Admin",
  role: "administrator",
  groups: [],
  areaIds: ["area-1"],
  createdAt: Date.parse("2026-09-24T10:00:00.000Z"),
  lastSeenAt: Date.parse("2026-09-24T10:00:00.000Z"),
  expiresAt: new Date("2026-09-24T11:00:00.000Z"),
};

const RUN_ID = "11111111-1111-4111-8111-111111111111";

const run = (overrides: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  areaId: "area-1",
  status: "queued",
  criticality: "read-only",
  scriptFileName: "inventory-report.sh",
  ...overrides,
});

beforeEach(() => {
  getRun.mockReset();
  transition.mockReset();
  appendEvent.mockReset();
  recordAbortRequest.mockReset();
  publish.mockReset();
  record.mockReset();
});

describe("aborting a run that has not started", () => {
  it("cancels a queued run rather than publishing a stop nobody can hear", async () => {
    getRun.mockResolvedValue(run());
    transition.mockResolvedValue(true);

    const result = await abortRun(SESSION, RUN_ID, {}, { sourceIp: "10.0.0.1" });

    expect(result.ok).toBe(true);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition.mock.calls[0]?.[1]).toBe("aborted");
    expect(transition.mock.calls[0]?.[3], "the claim is the race, and it is guarded").toEqual([
      "queued",
    ]);
    // The two dead writes, and the reason this is a cancel: nothing is
    // subscribed, so a published stop is dropped on the floor.
    expect(recordAbortRequest).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    // FA-12.1 — the audit says what happened, and it is now true.
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      actor: "admin.branch",
      action: "run_aborted",
      runId: RUN_ID,
      detail: { status: "queued" },
      sourceIp: "10.0.0.1",
    });
  });

  it("falls back to the channel when the worker claimed the run first", async () => {
    getRun.mockResolvedValue(run());
    // The worker moved it to `starting` between the read above and the guard.
    transition.mockResolvedValue(false);

    const result = await abortRun(SESSION, RUN_ID, {}, {});

    expect(result.ok).toBe(true);
    expect(recordAbortRequest).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("still stops a running run the way it always did", async () => {
    getRun.mockResolvedValue(run({ status: "running" }));

    const result = await abortRun(SESSION, RUN_ID, {}, {});

    expect(result.ok).toBe(true);
    expect(transition).not.toHaveBeenCalled();
    expect(recordAbortRequest).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("still asks a modifying script to be named before cancelling it", async () => {
    getRun.mockResolvedValue(run({ status: "queued", criticality: "modifying" }));

    const refused = await abortRun(SESSION, RUN_ID, {}, {});

    // FA-08.3 / ADR-003: a modifying script is stopped only by naming it, and
    // that rule is the *first* thing a queued cancel meets — otherwise the one
    // route that cancels before anything has run would be the one route without
    // the confirmation.
    expect(refused.ok).toBe(false);
    expect(transition).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();

    const confirmed = await abortRun(
      SESSION,
      RUN_ID,
      { confirmScriptName: "inventory-report.sh" },
      {},
    );

    expect(confirmed.ok).toBe(true);
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it("refuses a run that has already finished", async () => {
    getRun.mockResolvedValue(run({ status: "succeeded" }));

    const result = await abortRun(SESSION, RUN_ID, {}, {});

    expect(result.ok).toBe(false);
    expect(transition).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
