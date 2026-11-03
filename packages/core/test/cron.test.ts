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

  it("still survives an edit, because an edit changes neither command nor ordinal", () => {
    const command = "/opt/scriptoria/scripts/inventory-report.sh";
    expect(scheduleId("src-1", command, 1)).toBe(scheduleId("src-1", command, 1));
  });
});
