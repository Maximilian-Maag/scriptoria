import { describe, expect, it, vi } from "vitest";
import { RPC_FRAME, type RpcRequest } from "@scriptoria/contracts";
import type { Client, FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";

process.env.LOG_LEVEL = "error";

/**
 * What one bad SFTP read looks like on the wire, driven through the real
 * `RpcServer` and the real `SshExecutionTarget` with a fake ssh2 client (#52).
 *
 * This is the level the defect was invisible at: the driver swallowed the error,
 * the handler turned it into a successful payload, and the control plane acted
 * on `{ scripts: [] }` — marking every script of an area not present
 * (FA-03.3, FA-09.1). The frames asserted on here are the ones the backend
 * really drains (`apps/backend/src/lib/runner/client.ts`).
 */

const state = vi.hoisted(() => ({
  replies: [] as { frame: number; payload: string }[],
  requests: [] as unknown[],
  target: undefined as unknown,
}));

vi.mock("ioredis", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeRedis extends EventEmitter {
    private served = false;

    /** One blocking pop per server: the first request, then a wait. */
    async brpop(): Promise<[string, string] | null> {
      const request = this.served ? undefined : state.requests.shift();
      if (request === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return null;
      }
      this.served = true;
      return ["scriptoria:rpc:requests", JSON.stringify(request)];
    }

    async rpush(_key: string, entry: Buffer): Promise<number> {
      state.replies.push({
        frame: entry.readUInt8(0),
        payload: entry.subarray(1).toString("utf8"),
      });
      return 1;
    }

    async expire(): Promise<number> {
      return 1;
    }

    async lpush(): Promise<number> {
      return 1;
    }

    async quit(): Promise<"OK"> {
      return "OK";
    }

    disconnect(): void {}
  }

  return { default: FakeRedis };
});

vi.mock("../src/driver/sshTarget", async () => {
  const real =
    await vi.importActual<typeof import("../src/driver/sshTarget")>("../src/driver/sshTarget");
  // The connection itself is not what is under test: the real target class and
  // the real server are, with a peer whose SFTP answers as the test says.
  return { ...real, connectTo: async () => state.target };
});

import { SshExecutionTarget } from "../src/driver/sshTarget";
import { RpcServer } from "../src/rpc/server";

const TARGET = { host: "vm1.example.test", port: 22, username: "scriptoria" };

const SCAN: RpcRequest = {
  kind: "scan",
  id: "11111111-1111-4111-8111-111111111111",
  target: TARGET,
  scriptPath: "/opt/scriptoria/scripts",
};

const LIST_FILES: RpcRequest = {
  kind: "listFiles",
  id: "22222222-2222-4222-8222-222222222222",
  target: TARGET,
  directory: "/opt/scriptoria/export",
  since: null,
};

const READ_FILE: RpcRequest = {
  kind: "readFile",
  id: "33333333-3333-4333-8333-333333333333",
  target: TARGET,
  path: "/opt/scriptoria/export/report.txt",
  maxBytes: 1024 * 1024,
};

const PERMISSION_DENIED = 3;
const NO_SUCH_FILE = 2;

const refusal = (code: number): Error =>
  Object.assign(
    new Error(code === NO_SUCH_FILE ? "No such file or directory" : "Permission denied"),
    { code },
  );

type Frame = { frame: number; payload: string };

function clientWith(sftp: Partial<SFTPWrapper>): Client {
  return {
    sftp: (callback: (error: Error | null, wrapper: SFTPWrapper) => void) =>
      callback(null, sftp as SFTPWrapper),
    end: () => {},
  } as unknown as Client;
}

function entry(filename: string): FileEntryWithStats {
  return {
    filename,
    longname: filename,
    attrs: {
      size: 42,
      mtime: 1_700_000_000,
      mode: 0o100755,
      isDirectory: () => false,
      isFile: () => true,
    },
  } as unknown as FileEntryWithStats;
}

/** The one frame of a kind, or a failure that says which kind was missing. */
function frameOf(frames: Frame[], kind: number): Frame {
  const frame = frames.find((candidate) => candidate.frame === kind);
  expect(frame, `a frame of kind ${kind} in ${JSON.stringify(frames)}`).toBeDefined();
  return frame as Frame;
}

const errorOf = (frames: Frame[]): { code: string; message: string } =>
  JSON.parse(frameOf(frames, RPC_FRAME.ERROR).payload) as { code: string; message: string };

const jsonOf = <T>(frames: Frame[]): T => JSON.parse(frameOf(frames, RPC_FRAME.JSON).payload) as T;

/** A frame the reply cannot get past: the end, or the failure that ended it. */
const isTerminal = (frame: Frame): boolean =>
  frame.frame === RPC_FRAME.END || frame.frame === RPC_FRAME.ERROR;

/** The frames the runner would really write for one request. */
async function framesFor(request: RpcRequest, target: SshExecutionTarget): Promise<Frame[]> {
  state.replies.length = 0;
  state.requests.length = 0;
  state.requests.push(request);
  state.target = target;

  const server = new RpcServer();
  void server.start();

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !state.replies.some(isTerminal)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  server.stop();
  server.close();

  return [...state.replies];
}

describe("RpcServer, when a directory the caller asked for cannot be read", () => {
  it("answers a scan with an error frame, not with an empty catalogue", async () => {
    const target = new SshExecutionTarget(
      TARGET,
      clientWith({
        readdir: (_path: string, callback: (error: Error | undefined, list: []) => void) =>
          callback(refusal(PERMISSION_DENIED), []),
      }),
    );

    const frames = await framesFor(SCAN, target);

    // Success here is what emptied an area's catalogue: one error frame, and in
    // particular no `{ scripts: [] }` for the backend to act on.
    expect(frames.map((frame) => frame.frame)).toEqual([RPC_FRAME.ERROR]);

    const error = errorOf(frames);
    expect(error.code).toBe("upstream_unavailable");
    expect(error.message).toContain("Permission denied");
  });

  it("answers listFiles with an error frame, not with an empty result set (FA-09.1)", async () => {
    const target = new SshExecutionTarget(
      TARGET,
      clientWith({
        readdir: (_path: string, callback: (error: Error | undefined, list: []) => void) =>
          callback(refusal(PERMISSION_DENIED), []),
      }),
    );

    const frames = await framesFor(LIST_FILES, target);

    expect(frames.some((frame) => frame.frame === RPC_FRAME.JSON)).toBe(false);
    expect(errorOf(frames).code).toBe("upstream_unavailable");
  });

  it("still scans a directory that really is empty", async () => {
    const target = new SshExecutionTarget(
      TARGET,
      clientWith({
        readdir: (_path: string, callback: (error: Error | undefined, list: []) => void) =>
          callback(undefined, []),
      }),
    );

    const frames = await framesFor(SCAN, target);

    expect(jsonOf(frames)).toEqual({ scripts: [] });
    expect(frames.at(-1)?.frame).toBe(RPC_FRAME.END);
  });

  it("still lists a script directory that has scripts in it", async () => {
    const target = new SshExecutionTarget(
      TARGET,
      clientWith({
        readdir: (
          _path: string,
          callback: (error: Error | undefined, list: FileEntryWithStats[]) => void,
        ) => callback(undefined, [entry("nightly.sh")]),
      }),
    );

    const frames = await framesFor(SCAN, target);

    const payload = jsonOf<{ scripts: { fileName: string }[] }>(frames);
    expect(payload.scripts.map((script) => script.fileName)).toEqual(["nightly.sh"]);
  });
});

describe("RpcServer, when the file the caller asked for cannot be stat-ed", () => {
  it("answers with an error, not with `not_found` for a file that is there (FA-09.2)", async () => {
    const target = new SshExecutionTarget(
      TARGET,
      clientWith({
        stat: (_path: string, callback: (error: Error | undefined, stats: Stats) => void) =>
          callback(refusal(PERMISSION_DENIED), undefined as unknown as Stats),
      }),
    );

    const frames = await framesFor(READ_FILE, target);

    const error = errorOf(frames);
    expect(error.code).toBe("upstream_unavailable");
    expect(error.message).toContain("Permission denied");
  });

  it("still answers `not_found` for a file that is genuinely absent", async () => {
    const target = new SshExecutionTarget(
      TARGET,
      clientWith({
        stat: (_path: string, callback: (error: Error | undefined, stats: Stats) => void) =>
          callback(refusal(NO_SUCH_FILE), undefined as unknown as Stats),
      }),
    );

    const frames = await framesFor(READ_FILE, target);

    expect(errorOf(frames)).toMatchObject({ code: "not_found" });
  });
});
