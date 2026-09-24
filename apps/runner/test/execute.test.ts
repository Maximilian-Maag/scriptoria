/**
 * The run lifecycle, driven as a whole: the real `executeRun`, the real staged
 * abort and the real stream publisher, against a faked PTY, a faked Redis and
 * faked repositories.
 *
 * The alternative — testing a helper in isolation — cannot hold what is being
 * promised here, because every promise about a run is a promise about a
 * *sequence*: connect, open a terminal, stream every byte in order, stop when
 * asked, and then, whatever the exit code was, record what the script left
 * behind (FA-09.5). A sequence is exactly what a unit test of one step does not
 * have.
 *
 * Only the three seams at the edges are faked. Each is faked at its narrowest
 * point: `ioredis` (so the publisher and the control subscriber are the real
 * ones, and a test can deliver a control message the way Redis would),
 * `@scriptoria/db` (so the transitions and events a run writes are observable),
 * and `connectTo` (so the PTY is a scripted peer rather than a live VM).
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

process.env.LOG_LEVEL = "error";
// ADR-003's grace periods, shortened to the point where a test can wait them
// out. The stages themselves are what is asserted, not their durations.
process.env.ABORT_SIGINT_GRACE_MS = "20";
process.env.ABORT_SIGTERM_GRACE_MS = "20";

interface RedisState {
  commands: unknown[][];
  /** Connections the runner opened, so a test can deliver a message on one. */
  subscribers: EventEmitter[];
}

const REDIS = "__testRedis";

vi.mock("ioredis", async () => {
  const { EventEmitter: Emitter } = await import("node:events");

  class FakeRedis extends Emitter {
    constructor(..._args: unknown[]) {
      super();
      const state = (globalThis as Record<string, unknown>)[REDIS] as RedisState;
      state.subscribers.push(this);
    }

    async xadd(...args: unknown[]): Promise<string> {
      state().commands.push(["xadd", ...args]);
      return `${Date.now()}-${state().commands.length}`;
    }

    async expire(...args: unknown[]): Promise<number> {
      state().commands.push(["expire", ...args]);
      return 1;
    }

    async set(...args: unknown[]): Promise<string> {
      state().commands.push(["set", ...args]);
      return "OK";
    }

    async del(...args: unknown[]): Promise<number> {
      state().commands.push(["del", ...args]);
      return 1;
    }

    async subscribe(...args: unknown[]): Promise<void> {
      state().commands.push(["subscribe", ...args]);
    }

    disconnect(): void {}

    async quit(): Promise<"OK"> {
      return "OK";
    }
  }

  return { default: FakeRedis };
});

interface Transition {
  to: string;
  patch: Record<string, unknown>;
  /** False when the state guard refused it, which is its own kind of evidence. */
  accepted: boolean;
}

interface DbState {
  status: string;
  transitions: Transition[];
  events: { kind: string; message: string; stage: unknown }[];
  transcript: { sizeBytes: number; truncated: boolean } | null;
  /** -1 until something recorded results, so "never ran" is distinguishable. */
  results: number;
  collected: string[];
  resultCount: number[];
  /** What the next `findRunById` answers, as the run record stands. */
  run: Record<string, unknown>;
  /** Set to make the next transcript write fail, which is what #53 is about. */
  saveTranscriptThrows: boolean;
  /** Set to make the run's first read fail, the way a database blip does. */
  findRunThrows: boolean;
  /** Set to make every write fail, the way an unreachable database does. */
  transitionThrows: boolean;
  /** FA-12 audit entries the runner wrote, in order. */
  audit: Record<string, unknown>[];
}

const DB = "__testDb";

vi.mock("@scriptoria/db", async () => {
  const db: DbState = {
    status: "queued",
    transitions: [],
    events: [],
    transcript: null,
    results: -1,
    collected: [],
    resultCount: [],
    run: {},
    saveTranscriptThrows: false,
    findRunThrows: false,
    transitionThrows: false,
    audit: [],
  };
  (globalThis as Record<string, unknown>)[DB] = db;

  return {
    // `executeRun` imports this for the row types only.
    schema: {},
    runRepository: {
      findRunById: async () => {
        if (db.findRunThrows) throw new Error("the database is not answering");
        return db.run;
      },
      transition: async (
        _id: string,
        to: string,
        patch: Record<string, unknown> = {},
        from?: readonly string[],
      ) => {
        if (db.transitionThrows) throw new Error("the database is not answering");
        const accepted = from === undefined || from.includes(db.status);
        db.transitions.push({ to, patch, accepted });
        if (accepted) db.status = to;
        return accepted;
      },
      appendEvent: async (_id: string, kind: string, message: string, stage: unknown = null) => {
        db.events.push({ kind, message, stage });
      },
      saveTranscript: async (
        _id: string,
        _content: string,
        sizeBytes: number,
        truncated: boolean,
      ) => {
        if (db.saveTranscriptThrows) throw new Error("the transcript insert failed");
        db.transcript = { sizeBytes, truncated };
      },
      setResultCount: async (_id: string, count: number) => {
        db.resultCount.push(count);
      },
    },
    scriptRepository: {
      findScriptWithSource: async () => ({
        script: {
          id: "22222222-2222-4222-8222-222222222222",
          fileName: "nightly.sh",
          absolutePath: "/opt/scriptoria/scripts/nightly.sh",
        },
        source: {
          host: "vm1.example.test",
          port: 22,
          username: "scriptoria",
          scriptPath: "/opt/scriptoria/scripts",
        },
      }),
    },
    resultRepository: {
      recordResults: async (_runId: string, files: { path: string }[]) => {
        db.results = files.length;
        db.collected = files.map((file) => file.path);
        return files.length;
      },
    },
    auditRepository: {
      record: async (input: Record<string, unknown>) => {
        db.audit.push(input);
      },
    },
  };
});

interface ScriptState {
  signals: string[];
  dataListener: ((chunk: Buffer) => void) | null;
  resolveExit: (value: { code: number | null; signal: string | null }) => void;
  exit: Promise<{ code: number | null; signal: string | null }>;
  /** Incremented per listing, so "before" and "after" can differ. */
  listCalls: number;
}

const TARGET = "__testTarget";

vi.mock("../src/driver/sshTarget", async () => ({
  connectTo: async () => ({
    address: { host: "vm1.example.test", port: 22, username: "scriptoria" },
    connect: async () => {},
    stat: async () => ({ sizeBytes: 10, modifiedAt: new Date(), executable: true }),
    start: async (spec: { runId: string }) => {
      started.push(spec.runId);
      const script = (globalThis as Record<string, unknown>)[TARGET] as ScriptState;
      return {
        onData: (listener: (chunk: Buffer) => void) => {
          script.dataListener = listener;
        },
        write: () => {},
        resize: () => {},
        signal: async (stage: string) => {
          script.signals.push(stage);
        },
        exit: script.exit,
      };
    },
    list: async () => {
      const script = (globalThis as Record<string, unknown>)[TARGET] as ScriptState;
      script.listCalls += 1;
      // The first listing is the snapshot taken before the script starts; the
      // file appears in the second, which is what a run that produced a result
      // looks like from here.
      if (script.listCalls === 1) return { entries: [], truncated: false };
      return {
        entries: [
          {
            path: "report.txt",
            name: "report.txt",
            sizeBytes: 12,
            modifiedAt: new Date(1_700_000_000_000),
            executable: false,
          },
        ],
        truncated: false,
      };
    },
    read: async () => ({ sizeBytes: 0, truncated: false }),
    readHead: async () => Buffer.alloc(0),
    readCrontab: async () => null,
    writeCrontab: async () => {},
    cleanup: async () => {},
    close: () => {},
  }),
}));

const { executeRun } = await import("../src/run/execute");

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const WORKER = { workerId: "w1", renewClaim: async () => {} };

/** Runs `executeRun` has actually started the script for. */
const started: string[] = [];

const state = (): RedisState => (globalThis as Record<string, unknown>)[REDIS] as RedisState;
const db = (): DbState => (globalThis as Record<string, unknown>)[DB] as DbState;

/** A macrotask, so everything queued as a microtask has run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Enough turns for `executeRun` to have reached `await running.exit`. */
async function running(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await tick();
}

function fresh(): ScriptState {
  (globalThis as Record<string, unknown>)[REDIS] = {
    commands: [],
    subscribers: [],
  } satisfies RedisState;

  const db = (globalThis as Record<string, unknown>)[DB] as DbState;
  db.status = "queued";
  db.transitions = [];
  db.events = [];
  db.transcript = null;
  db.results = -1;
  db.collected = [];
  db.resultCount = [];
  db.saveTranscriptThrows = false;
  db.findRunThrows = false;
  db.transitionThrows = false;
  db.audit = [];
  db.run = {
    id: RUN_ID,
    scriptId: "22222222-2222-4222-8222-222222222222",
    status: "queued",
    cols: 80,
    rows: 24,
    outputPath: "/opt/scriptoria/export",
    scriptFileName: "nightly.sh",
    startedBy: "admin",
  };
  started.length = 0;

  let resolveExit: (value: { code: number | null; signal: string | null }) => void = () => {};
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveExit = resolve;
  });
  const script: ScriptState = { signals: [], dataListener: null, resolveExit, exit, listCalls: 0 };
  (globalThis as Record<string, unknown>)[TARGET] = script;
  return script;
}

describe("executeRun", () => {
  /**
   * The baseline the rest of this file reads against: a script that prints, exits
   * 0 and leaves a file behind.
   */
  it("streams every chunk in order, keeps the scrollback and collects the results", async () => {
    const script = fresh();
    const done = executeRun(RUN_ID, WORKER);
    await running();

    script.dataListener?.(Buffer.from("hello "));
    script.dataListener?.(Buffer.from("world"));
    await tick();

    script.resolveExit({ code: 0, signal: null });
    await done;

    const chunks = state().commands.filter((command) => command[0] === "xadd");
    expect(chunks).toHaveLength(2);
    expect(db().transcript?.sizeBytes).toBe(11);
    expect(db().collected).toEqual(["report.txt"]);
    expect(db().resultCount).toEqual([1]);
    expect(db().transitions.map((t) => t.to)).toEqual(["starting", "running", "succeeded"]);
  });

  /**
   * The defect this file gained its first test for: the transcript write and the
   * result collection sat on one failure cliff, so a database blip on the
   * transcript took the results with it. The run still says `succeeded` — it did
   * — and an operator is shown a panel that says it wrote nothing.
   */
  it("still collects the results when the transcript write fails", async () => {
    const script = fresh();
    db().saveTranscriptThrows = true;

    const done = executeRun(RUN_ID, WORKER);
    await running();
    script.resolveExit({ code: 0, signal: null });
    await done;

    expect(db().transcript).toBeNull();
    expect(db().collected).toEqual(["report.txt"]);
    expect(db().transitions.map((t) => t.to)).toEqual(["starting", "running", "succeeded"]);
    expect(db().events.map((e) => `${e.kind}: ${e.message}`)).toContain(
      "error: Transcript not persisted: Error: the transcript insert failed",
    );
  });

  /**
   * A run whose start throws is consumed and forgotten: the job is gone from the
   * queue, the claim is released as the worker unwinds, and the run's row is
   * left where the last write put it. Nothing retries it, and an operator is
   * shown a run that is still starting for ever (FA-05).
   *
   * The throw is the first read, which is what a database briefly not answering
   * looks like from here — and it is the case the record can still be corrected
   * for, because every later write succeeds.
   */
  it("records a failed start rather than leaving the run where it was", async () => {
    fresh();
    db().findRunThrows = true;

    await executeRun(RUN_ID, WORKER);

    expect(db().status).toBe("failed");
    expect(db().transitions.map((t) => `${t.to}/${String(t.patch.failureReason)}`)).toEqual([
      "failed/start_failed",
    ]);
    expect(db().events.map((e) => `${e.kind}: ${e.message}`)).toEqual([
      "error: Error: the database is not answering",
    ]);
  });

  /**
   * And when the database is not answering at all there is nowhere to write that
   * correction. The run's row is beyond saving then, but the worker's queue slot
   * is not: rejecting here would unwind through the consumer, and a consumer
   * that stops consuming looks exactly like a platform where nothing starts.
   */
  it("does not throw out of the worker when nothing can be recorded", async () => {
    fresh();
    db().findRunThrows = true;
    db().transitionThrows = true;

    await expect(executeRun(RUN_ID, WORKER)).resolves.toBeUndefined();
  });
});
