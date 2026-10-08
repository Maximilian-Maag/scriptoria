import { describe, expect, it } from "vitest";
import { commandRunsScript } from "../src/scriptReference";

/**
 * FA-10.3 — which script a crontab line runs, as a pure rule.
 *
 * This decides whether the schedules view offers a *Run now* for a line, and
 * pressing it starts the script the answer names. A rule carrying that much
 * weight should be readable in one screen and testable without a crontab, a
 * database or a script VM anywhere near it.
 */

const SCRIPT = "/opt/scriptoria/scripts/deploy.sh";

describe("commandRunsScript", () => {
  it("matches the path as a whole word, however it is spaced", () => {
    expect(commandRunsScript(`0 3 * * * ${SCRIPT}`, SCRIPT)).toBe(true);
    expect(commandRunsScript(`${SCRIPT} --full`, SCRIPT)).toBe(true);
    expect(commandRunsScript(`/bin/bash ${SCRIPT}`, SCRIPT)).toBe(true);
    expect(commandRunsScript(`cd /opt && ${SCRIPT}`, SCRIPT)).toBe(true);
  });

  it("matches when the command redirects or quotes the path", () => {
    expect(commandRunsScript(`${SCRIPT} >> /opt/scriptoria/export/log 2>&1`, SCRIPT)).toBe(true);
    expect(commandRunsScript(`"${SCRIPT}"`, SCRIPT)).toBe(true);
    expect(commandRunsScript(`'${SCRIPT}' -v`, SCRIPT)).toBe(true);
    expect(commandRunsScript(`${SCRIPT};echo done`, SCRIPT)).toBe(true);
  });

  it("does not match a longer path that merely begins with it", () => {
    // The case this exists for: a `.in`/`.bak`/`.old` sibling of the script.
    expect(commandRunsScript("/opt/scriptoria/scripts/deploy.sh.in", SCRIPT)).toBe(false);
    expect(commandRunsScript("/opt/scriptoria/scripts/deploy.sh.bak", SCRIPT)).toBe(false);
    expect(commandRunsScript("/opt/scriptoria/scripts/deploy.sh.old --now", SCRIPT)).toBe(false);
    // And siblings whose suffix is not one of the characters the rule used to
    // call "not part of a path": a file name may contain `+` or `%`, so the
    // boundary cannot be decided by a list of path characters.
    expect(commandRunsScript("/opt/scriptoria/scripts/deploy.sh+backup", SCRIPT)).toBe(false);
    expect(commandRunsScript("/opt/scriptoria/scripts/deploy.sh%2024", SCRIPT)).toBe(false);
  });

  it("does not match a shorter path it begins with", () => {
    expect(
      commandRunsScript("/opt/scriptoria/scripts/deploy.sh", "/opt/scriptoria/scripts/deploy"),
    ).toBe(false);
  });

  it("does not match a match buried inside a longer path", () => {
    expect(commandRunsScript("/mnt/backup/opt/scriptoria/scripts/deploy.sh", SCRIPT)).toBe(false);
    expect(commandRunsScript("/opt/scriptoria/scripts/archive/deploy.sh", SCRIPT)).toBe(false);
  });

  it("does not match a different script whose name contains it", () => {
    expect(commandRunsScript("/opt/scriptoria/scripts/my-deploy.sh", SCRIPT)).toBe(false);
  });

  it("does not match when the path is absent", () => {
    expect(commandRunsScript("/usr/local/bin/something-else.sh", SCRIPT)).toBe(false);
    expect(commandRunsScript("", SCRIPT)).toBe(false);
  });

  it("finds the whole-word occurrence even when a longer one comes first", () => {
    // A command that mentions the path twice: once inside a longer word and once
    // as the thing it runs. The second occurrence is the one that counts.
    const command = `${SCRIPT}.bak && ${SCRIPT}`;
    expect(commandRunsScript(command, SCRIPT)).toBe(true);
  });

  it("answers false for an empty path rather than matching everywhere", () => {
    expect(commandRunsScript("anything at all", "")).toBe(false);
  });
});
