import { describe, expect, it } from "vitest";
import { utils, type Client, type FileEntryWithStats, type SFTPWrapper } from "ssh2";
import { SshExecutionTarget } from "../src/driver/sshTarget";

process.env.LOG_LEVEL = "error";

const ADDRESS = { host: "vm1.example.test", port: 22, username: "scriptoria" };

/**
 * The two failures that must not be confused with each other.
 *
 * ssh2 puts the SSH_FX status code on the error object, and only NO_SUCH_FILE
 * means the path is absent — which is the whole distinction the driver has to
 * make (FA-09.2).
 */
const permissionDenied = (): Error =>
  Object.assign(new Error("Permission denied"), {
    code: utils.sftp.STATUS_CODE.PERMISSION_DENIED,
  });

const noSuchFile = (): Error =>
  Object.assign(new Error("No such file or directory"), {
    code: utils.sftp.STATUS_CODE.NO_SUCH_FILE,
  });

function entry(filename: string, kind: "file" | "directory"): FileEntryWithStats {
  return {
    filename,
    longname: filename,
    attrs: {
      size: kind === "file" ? 42 : 0,
      mtime: 1_700_000_000,
      mode: kind === "directory" ? 0o040755 : 0o100755,
      isDirectory: () => kind === "directory",
      isFile: () => kind === "file",
    },
  } as unknown as FileEntryWithStats;
}

/** A target whose SFTP subsystem is whatever this test needs it to be. */
function targetWith(sftp: Partial<SFTPWrapper>): SshExecutionTarget {
  const client = {
    sftp: (callback: (error: Error | null, wrapper: SFTPWrapper) => void) =>
      callback(null, sftp as SFTPWrapper),
    end: () => {},
  } as unknown as Client;
  return new SshExecutionTarget(ADDRESS, client);
}

describe("SshExecutionTarget.list", () => {
  it("reports a directory the caller asked for that cannot be read as a failure", async () => {
    // The defect #52 is about: this used to resolve with `{ entries: [] }`, and
    // `scan` reported that as a successful, empty catalogue — which marks every
    // script of the area not present (FA-03.3, FA-09.1).
    const target = targetWith({
      readdir: (_path, callback) => callback(permissionDenied(), []),
    });

    await expect(
      target.list("/opt/scriptoria/scripts", { maxDepth: 0, maxEntries: 1_000 }),
    ).rejects.toThrow("Permission denied");
  });

  it("still skips a subdirectory it cannot read, keeping its siblings", async () => {
    // The tolerance that legitimately belongs here: a date-stamped result folder
    // the account cannot read must not cost the rest of the result set, because
    // the result has to be visible at all (FA-09.5).
    const target = targetWith({
      readdir: (path, callback) => {
        if (path === "/opt/scriptoria/export/results") callback(permissionDenied(), []);
        else callback(undefined, [entry("report.txt", "file"), entry("results", "directory")]);
      },
    });

    const listing = await target.list("/opt/scriptoria/export");

    expect(listing.entries.map((item) => item.path)).toEqual(["report.txt"]);
    expect(listing.truncated).toBe(false);
  });

  it("still reports a directory that is genuinely empty as empty", async () => {
    const target = targetWith({ readdir: (_path, callback) => callback(undefined, []) });

    await expect(target.list("/opt/scriptoria/scripts")).resolves.toEqual({
      entries: [],
      truncated: false,
    });
  });
});

describe("SshExecutionTarget.stat", () => {
  it("fails on a stat that failed, instead of claiming the file is not there", async () => {
    // `readFile` turns a null here into `not_found`, so a permission error was
    // answered to the operator as a missing file that is in fact there (FA-09.2).
    const target = targetWith({
      stat: (_path, callback) =>
        callback(permissionDenied(), undefined as unknown as Parameters<typeof callback>[1]),
    });

    await expect(target.stat("/opt/scriptoria/export/report.txt")).rejects.toThrow(
      "Permission denied",
    );
  });

  it("still reports a file that is not there as absent", async () => {
    const target = targetWith({
      stat: (_path, callback) =>
        callback(noSuchFile(), undefined as unknown as Parameters<typeof callback>[1]),
    });

    await expect(target.stat("/opt/scriptoria/export/gone.txt")).resolves.toBeNull();
  });

  it("reads the facts of a file that is there", async () => {
    const target = targetWith({
      stat: (_path, callback) =>
        callback(undefined, {
          size: 4096,
          mtime: 1_700_000_000,
          mode: 0o100755,
        } as unknown as Parameters<typeof callback>[1]),
    });

    await expect(target.stat("/opt/scriptoria/scripts/nightly.sh")).resolves.toEqual({
      sizeBytes: 4096,
      modifiedAt: new Date(1_700_000_000 * 1000),
      executable: true,
    });
  });
});
