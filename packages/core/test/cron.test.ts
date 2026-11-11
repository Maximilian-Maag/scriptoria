import { describe, expect, it } from "vitest";
import { nextRunAt, scheduleId, validateCronExpression } from "../src/cron";

describe("validateCronExpression", () => {
  it("accepts a five-field expression and describes it", () => {
    const result = validateCronExpression("17 3 * * *");
    expect(result.valid).toBe(true);
    expect(result.description).not.toBe("");
  });

  it("rejects nonsense with a reason rather than throwing", () => {
    const result = validateCronExpression("not a cron expression");
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("nextRunAt", () => {
  it("defaults to UTC, so an unconfigured deployment is at least predictable", () => {
    const from = new Date("2026-01-15T00:00:00Z");
    expect(nextRunAt("0 3 * * *", { from })?.toISOString()).toBe("2026-01-15T03:00:00.000Z");
  });

  it("honours an explicit timezone, because a crontab means the VM's local time", () => {
    const from = new Date("2026-01-15T00:00:00Z");
    // 00:00 UTC is already 09:00 in Tokyo, so the next 03:00 there is the
    // following day — which is 18:00 UTC on the 15th.
    const next = nextRunAt("0 3 * * *", { from, timezone: "Asia/Tokyo" });
    expect(next?.toISOString()).toBe("2026-01-15T18:00:00.000Z");
  });

  it("returns null rather than throwing for an invalid expression", () => {
    expect(nextRunAt("nonsense")).toBeNull();
  });

  it("takes no options at all, which is how the schedule list calls it", () => {
    // No `from` and no timezone: both reads are optional in the signature, and a
    // call that needs one of them would be a call the interface does not make.
    const next = nextRunAt("0 3 * * *");
    expect(next).toBeInstanceOf(Date);
    expect(next?.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("scheduleId", () => {
  it("survives an edit to the expression — that is the point of it", () => {
    const command = "/opt/scriptoria/scripts/inventory-report.sh";
    expect(scheduleId("src-1", command)).toBe(scheduleId("src-1", command));
  });

  it("differs per source, so two VMs running the same script are two schedules", () => {
    const command = "/opt/scriptoria/scripts/inventory-report.sh";
    expect(scheduleId("src-1", command)).not.toBe(scheduleId("src-2", command));
  });

  it("separates the same command scheduled twice at different times", () => {
    // Exactly what the fixture crontab holds: one hand-written line and one
    // inside the managed block, running the same script at different hours.
    // Keyed on the command alone these collide, and the interface then offers
    // to edit one line while editing the other.
    const command = "/opt/scriptoria/scripts/inventory-report.sh";
    expect(scheduleId("src-1", command, 0)).not.toBe(scheduleId("src-1", command, 1));
  });

  it("is a fixed function of source, command and ordinal", () => {
    // Pinned rather than compared with itself: an id that drifts when the hash
    // is touched is a schedule the interface loses across a deployment.
    const command = "/opt/scriptoria/scripts/inventory-report.sh";
    expect(scheduleId("src-1", command)).toBe("f9898c98");
    expect(scheduleId("src-1", command, 1)).toBe("fa898e2b");
    expect(scheduleId("src-2", command)).toBe("20e27325");
  });

  it("is always eight characters, so an id is an id and not a number", () => {
    // This input hashes low enough that the zero padding is load-bearing: without
    // it the id would be seven characters, and anything comparing ids as fixed
    // width — a column, a log line, a test — would be comparing two shapes.
    expect(scheduleId("vm-b", "/opt/scriptoria/scripts/a")).toBe("0c6cc4e3");
    expect(scheduleId("vm-b", "/opt/scriptoria/scripts/a")).toHaveLength(8);
  });

  it("ignores whitespace around the command, because a crontab line is not typed by hand", () => {
    const command = "/opt/scriptoria/scripts/inventory-report.sh";
    expect(scheduleId("src-1", `  ${command}\t`)).toBe(scheduleId("src-1", command));
  });

  it("still survives an edit, because an edit changes neither command nor ordinal", () => {
    const command = "/opt/scriptoria/scripts/inventory-report.sh";
    expect(scheduleId("src-1", command, 1)).toBe(scheduleId("src-1", command, 1));
  });
});
