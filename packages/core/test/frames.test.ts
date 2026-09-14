import { describe, expect, it } from "vitest";
import {
  FrameError,
  decodeTerminalFrame,
  encodeStdinFrame,
  encodeTerminalFrame,
} from "../src/frames";

describe("terminal frames", () => {
  it("round-trips a chunk with its stream id", () => {
    const data = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x68, 0x69]);
    const decoded = decodeTerminalFrame(encodeTerminalFrame("1736899200000-0", data));

    expect(decoded.streamId).toBe("1736899200000-0");
    expect([...decoded.data]).toEqual([...data]);
  });

  it("carries bytes, not text — a split UTF-8 sequence survives reassembly", () => {
    // This is the bug ADR-006 is written to prevent: "Ä" is 0xC3 0x84, and a PTY
    // read can land between them. Decoding each chunk to a string independently
    // turns it into two replacement characters. Here each half travels as bytes
    // and only the concatenation is decoded, which is what xterm.js does.
    const encoder = new TextEncoder();
    const full = encoder.encode("Änderung");
    const first = decodeTerminalFrame(encodeTerminalFrame("1-0", full.subarray(0, 1)));
    const second = decodeTerminalFrame(encodeTerminalFrame("1-1", full.subarray(1)));

    const rejoined = new Uint8Array(first.data.length + second.data.length);
    rejoined.set(first.data, 0);
    rejoined.set(second.data, first.data.length);

    expect(new TextDecoder().decode(rejoined)).toBe("Änderung");
  });

  it("gives stdin frames an empty stream id — keystrokes have no position", () => {
    const decoded = decodeTerminalFrame(encodeStdinFrame(new TextEncoder().encode("y\r")));
    expect(decoded.streamId).toBe("");
    expect(new TextDecoder().decode(decoded.data)).toBe("y\r");
  });

  it("handles an empty payload", () => {
    const decoded = decodeTerminalFrame(encodeTerminalFrame("5-0", new Uint8Array()));
    expect(decoded.streamId).toBe("5-0");
    expect(decoded.data.length).toBe(0);
  });

  it("rejects a frame shorter than its header", () => {
    expect(() => decodeTerminalFrame(new Uint8Array([0x01]))).toThrow(FrameError);
  });

  it("rejects an unknown opcode instead of guessing", () => {
    const frame = encodeTerminalFrame("1-0", new Uint8Array([1]));
    frame[0] = 0x7f;
    expect(() => decodeTerminalFrame(frame)).toThrow(FrameError);
  });

  it("rejects a truncated stream id", () => {
    const frame = encodeTerminalFrame("1736899200000-0", new Uint8Array([1]));
    expect(() => decodeTerminalFrame(frame.subarray(0, 6))).toThrow(FrameError);
  });
});
