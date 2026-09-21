import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MANAGED_BEGIN,
  MANAGED_END,
  managedJobs,
  parseCrontab,
  renderCrontab,
  writeManagedBlock,
} from "../src/crontab";

/**
 * The fixture crontab is the test input on purpose. ADR-005's consequence — the
 * platform leaves foreign lines byte-for-byte intact — is only worth anything if
 * it holds for a file somebody actually wrote, oddly spaced comments included.
 */
const FIXTURE = readFileSync(
  fileURLToPath(new URL("../../../infra/sshd/crontab", import.meta.url)),
  "utf8",
);

describe("parseCrontab", () => {
  it("round-trips a real crontab byte for byte", () => {
    expect(renderCrontab(parseCrontab(FIXTURE))).toBe(FIXTURE);
  });

  it("recognises the environment assignments as assignments, not jobs", () => {
    const lines = parseCrontab(FIXTURE);
    const env = lines.filter((l) => l.kind === "env");
    expect(env.map((l) => (l.kind === "env" ? l.name : ""))).toEqual(["MAILTO", "PATH"]);
  });

  it("keeps the command's own spacing", () => {
    const lines = parseCrontab("30   4   *   *   1    /usr/bin/find /opt -type f  -delete\n");
    const job = lines.find((l) => l.kind === "job");
    expect(job?.kind).toBe("job");
    if (job?.kind !== "job") return;
    expect(job.expression).toBe("30 4 * * 1");
    expect(job.command).toBe("/usr/bin/find /opt -type f  -delete");
  });

  it("marks only the lines inside the delimiters as managed", () => {
    const jobs = parseCrontab(FIXTURE).filter((l) => l.kind === "job");
    const managed = jobs.filter((l) => l.kind === "job" && l.managed);
    expect(jobs.length).toBe(3);
    expect(managed.length).toBe(1);
  });

  it("reads a commented-out job as a disabled job, not as a comment", () => {
    const lines = parseCrontab("# 0 5 * * * /opt/scriptoria/scripts/thing.sh\n");
    const job = lines.find((l) => l.kind === "job");
    expect(job?.kind === "job" && job.enabled).toBe(false);
  });

  it("reads a nickname schedule", () => {
    const lines = parseCrontab("@daily /opt/scriptoria/scripts/thing.sh\n");
    const job = lines.find((l) => l.kind === "job");
    expect(job?.kind === "job" && job.expression).toBe("@daily");
  });
});

describe("writeManagedBlock", () => {
  it("changes the managed block and nothing else", () => {
    const before = FIXTURE.split(MANAGED_BEGIN)[0];
    const after = writeManagedBlock(FIXTURE, [
      { expression: "0 3 * * *", command: "/opt/scriptoria/scripts/inventory-report.sh", enabled: true },
      { expression: "15 6 * * 1", command: "/opt/scriptoria/scripts/site-rollout.sh", enabled: false },
    ]);

    // The hand-written half of the file is untouched, comments and odd spacing
    // included. This is the assertion ADR-005 is actually about.
    expect(after.startsWith(before as string)).toBe(true);
    expect(after).toContain("30   4   *   *   1    /usr/bin/find");
    expect(after).toContain("17 3 * * * /opt/scriptoria/scripts/inventory-report.sh");

    const managed = managedJobs(parseCrontab(after));
    expect(managed).toEqual([
      { expression: "0 3 * * *", command: "/opt/scriptoria/scripts/inventory-report.sh", enabled: true },
      { expression: "15 6 * * 1", command: "/opt/scriptoria/scripts/site-rollout.sh", enabled: false },
    ]);
  });

  it("empties the block without eating the delimiters", () => {
    const after = writeManagedBlock(FIXTURE, []);
    expect(after).toContain(MANAGED_BEGIN);
    expect(after).toContain(MANAGED_END);
    expect(managedJobs(parseCrontab(after))).toEqual([]);
  });

  it("appends a block to a crontab that has none, leaving the rest alone", () => {
    const foreign = "MAILTO=\"\"\n\n# theirs\n0 1 * * * /usr/local/bin/backup.sh\n";
    const after = writeManagedBlock(foreign, [
      { expression: "0 2 * * *", command: "/opt/scriptoria/scripts/x.sh", enabled: true },
    ]);

    expect(after).toContain("# theirs");
    expect(after).toContain("0 1 * * * /usr/local/bin/backup.sh");
    expect(managedJobs(parseCrontab(after))).toEqual([
      { expression: "0 2 * * *", command: "/opt/scriptoria/scripts/x.sh", enabled: true },
    ]);
  });

  it("is idempotent — writing back what it read changes nothing", () => {
    const once = writeManagedBlock(FIXTURE, managedJobs(parseCrontab(FIXTURE)));
    expect(once).toBe(FIXTURE);
  });

  it("repairs an unterminated block instead of writing the jobs a second time", () => {
    // An interrupted write: the opening delimiter landed, the closing one did
    // not. `parseCrontab` reads the lines after it as managed, so the writer has
    // to treat them as its own — appending a second block instead leaves the
    // original job in place *and* writes it again below, which is a crontab that
    // runs the same job twice.
    const interrupted = [
      'MAILTO="ops@example.com"',
      MANAGED_BEGIN,
      "30   4   *   *   1    /usr/bin/find /opt/scriptoria/export -type f -mtime +30 -delete",
      "",
    ].join("\n");

    const once = writeManagedBlock(interrupted, managedJobs(parseCrontab(interrupted)));
    const carrying = once.split("\n").filter((l) => l.includes("/usr/bin/find"));

    expect(carrying).toHaveLength(1);
    expect(once).toContain(MANAGED_END);
    expect(once).toContain('MAILTO="ops@example.com"');
    expect(writeManagedBlock(once, managedJobs(parseCrontab(once)))).toBe(once);
  });

  it("keeps the lines above a dangling opening delimiter byte for byte", () => {
    const foreign = 'PATH=/usr/bin\n# theirs\n7 7 * * 7 /usr/local/bin/weekly.sh\n';
    const interrupted = `${foreign}${MANAGED_BEGIN}\n0 1 * * * /opt/scriptoria/scripts/x.sh\n`;

    const after = writeManagedBlock(interrupted, [
      { expression: "0 2 * * *", command: "/opt/scriptoria/scripts/y.sh", enabled: true },
    ]);

    expect(after.startsWith(foreign)).toBe(true);
    expect(after).not.toContain("/opt/scriptoria/scripts/x.sh");
    expect(managedJobs(parseCrontab(after))).toEqual([
      { expression: "0 2 * * *", command: "/opt/scriptoria/scripts/y.sh", enabled: true },
    ]);
  });
});
