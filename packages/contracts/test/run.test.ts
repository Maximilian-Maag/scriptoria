import { describe, expect, it } from "vitest";
import {
  isTerminalStatus,
  LIVE_RUN_STATUSES,
  runStatusSchema,
  startRunRequestSchema,
  TERMINAL_RUN_STATUSES,
  type RunStatus,
} from "../src/run";

/**
 * The contract's own invariants — and this package's first tests.
 *
 * Everything here is a shared definition: the control plane, the runner, the
 * interface and the end-to-end suite all read their vocabulary from this
 * package, so a change here is a change in four places at once, made once,
 * where none of the four can see the other three. The tests are cheap because
 * the schemas are pure and need no service; they are worth having for exactly
 * that asymmetry — the blast radius is the whole repository and the check is
 * milliseconds.
 */

/**
 * FA-05.5 — "there is no parametrisation before the start."
 *
 * A start says *which* script, and how big the terminal is. It cannot say
 * anything else: not a parameter, not an argument, not an environment. That is
 * a claim about the shape of the message, so this is the place to hold it.
 */
describe("a start request (FA-05.5)", () => {
  it("carries a script and a terminal size, and nothing else", () => {
    expect(Object.keys(startRunRequestSchema.shape).sort()).toEqual(["cols", "rows", "scriptId"]);
  });

  it("drops an argument a client tries to send with it", () => {
    // Zod strips what it does not know, so a client that believes it can
    // parametrise the start gets a request with the parameters removed rather
    // than one that carries them to a runner that would ignore them. The
    // parameters an operator sees are the ones the *script* declares (FA-05.2),
    // and they are asked for on the terminal, after the start.
    const parsed = startRunRequestSchema.parse({
      scriptId: "3c2f5b7a-8d91-4e6f-a1b2-c3d4e5f60718",
      arguments: ["--site", "west"],
    });

    expect(parsed).toEqual({ scriptId: "3c2f5b7a-8d91-4e6f-a1b2-c3d4e5f60718" });
  });

  it("refuses a start with no script in it", () => {
    expect(startRunRequestSchema.safeParse({ cols: 80, rows: 24 }).success).toBe(false);
  });
});

/**
 * The run state machine (FA-07.2, FA-08, FA-10.2).
 *
 * Whether a run is over decides *where the console reads it from*: a run that
 * is still going is watched on a socket, and a run that has finished is read
 * back from the durable copy of its terminal. Get the classification wrong in
 * the direction of "still live" and a finished run's console attaches to a
 * stream that has expired, one requirement away from the empty terminal FA-07.5
 * is about.
 */
describe("the run status machine (FA-07.2, FA-08, FA-10.2)", () => {
  it("classifies every status it declares as live or terminal, exactly once", () => {
    // The assertion that matters is not "isTerminalStatus agrees with
    // TERMINAL_RUN_STATUSES" — that is one function reading one list. It is
    // that the two lists together are the schema's statuses: a status added to
    // the machine and classified in neither list is a state no part of the
    // platform knows how to treat.
    const classified: RunStatus[] = [...LIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES];

    expect([...classified].sort()).toEqual([...runStatusSchema.options].sort());
    expect(new Set(classified).size, "a status classified twice is ambiguous").toBe(
      classified.length,
    );
  });

  it("does not call a status both", () => {
    for (const status of runStatusSchema.options) {
      expect(isTerminalStatus(status), status).toBe(
        !(LIVE_RUN_STATUSES as readonly string[]).includes(status),
      );
    }
  });

  it("keeps `aborted` distinct from `failed`", () => {
    // ADR-003 needs the distinction for the audit trail and FA-10.2 needs it
    // for "last successful". A machine that folded the two would lose both
    // quietly: a stopped run would read as a broken one.
    expect(runStatusSchema.options).toContain("aborted");
    expect(runStatusSchema.options).toContain("failed");
    expect(isTerminalStatus("aborted")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
  });

  it("treats an accepted run as live, before any worker has touched it", () => {
    // FA-05.1's start: the run exists from the moment it is accepted, and the
    // console is watching it from that moment. Nothing here is terminal.
    expect(isTerminalStatus("queued")).toBe(false);
    expect(isTerminalStatus("starting")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
  });
});
