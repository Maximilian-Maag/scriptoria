import { describe, expect, it } from "vitest";
import { chooseAdmissions, type QueuedCandidate } from "../src/dispatch";

const queued = (...hosts: string[]): QueuedCandidate[] =>
  hosts.map((host, index) => ({ id: `run-${index + 1}`, host }));

describe("chooseAdmissions", () => {
  it("gives a free script VM its run", () => {
    expect(chooseAdmissions(queued("vm-a"), new Map(), 1, 10)).toEqual(["run-1"]);
  });

  it("keeps the second run of a busy script VM waiting, and says which one it kept", () => {
    // The whole point of O-7: two scripts against one VM, one at a time, oldest first.
    const candidates = queued("vm-a", "vm-a");
    expect(chooseAdmissions(candidates, new Map([["vm-a", 1]]), 1, 10)).toEqual([]);
    expect(chooseAdmissions(candidates, new Map(), 1, 10)).toEqual(["run-1"]);
  });

  it("admits runs to different script VMs independently", () => {
    // A busy fixture must not hold up a production script VM, or the limit turns
    // into a platform-wide queue with one operator's script at the front.
    expect(chooseAdmissions(queued("vm-a", "vm-b"), new Map([["vm-a", 1]]), 1, 10)).toEqual([
      "run-2",
    ]);
  });

  it("honours a raised limit, and counts what is already running", () => {
    const candidates = queued("vm-a", "vm-a", "vm-a");
    // Two already running, limit three: exactly one more.
    expect(chooseAdmissions(candidates, new Map([["vm-a", 2]]), 3, 10)).toEqual(["run-1"]);
  });

  it("admits nothing when a host is at its limit, rather than going negative", () => {
    expect(chooseAdmissions(queued("vm-a"), new Map([["vm-a", 4]]), 1, 10)).toEqual([]);
  });

  it("stops at the batch size, so one sweep cannot dispatch an unbounded list", () => {
    expect(chooseAdmissions(queued("vm-a", "vm-b", "vm-c"), new Map(), 1, 2)).toEqual([
      "run-1",
      "run-2",
    ]);
  });

  it("treats a limit below one as nothing admitted, which is a configuration bug", () => {
    expect(chooseAdmissions(queued("vm-a"), new Map(), 0, 10)).toEqual([]);
  });
});
