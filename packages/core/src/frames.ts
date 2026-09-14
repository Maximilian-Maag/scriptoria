import { STREAM_FRAME, STREAM_ID_LENGTH_OFFSET, STREAM_ID_OFFSET } from "@scriptoria/contracts";

/**
 * ADR-006 — the binary terminal frame, encoded and decoded in one place so the
 * runner, the gateway and the browser cannot disagree about it.
 *
 * The payload is never decoded to a string anywhere on this path. A PTY read can
 * split a multi-byte UTF-8 sequence across two chunks; decoding each chunk
 * independently corrupts the character at the boundary — intermittently, usually
 * only under load, and visibly in exactly the German-language output this
 * platform exists to show. xterm.js takes bytes and handles the boundary itself.
 *
 *   byte 0        opcode
 *   byte 1..2     big-endian length of the stream id
 *   byte 3..3+n   the stream id, ASCII
 *   rest          the terminal bytes, untouched
 */

export interface TerminalFrame {
  /** Empty for client → server stdin, which has no position in the stream. */
  streamId: string;
  data: Uint8Array;
}

export class FrameError extends Error {}

export function encodeTerminalFrame(streamId: string, data: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(streamId);
  if (id.length > 0xffff) throw new FrameError("stream id too long");

  const frame = new Uint8Array(STREAM_ID_OFFSET + id.length + data.length);
  frame[0] = STREAM_FRAME.DATA;
  new DataView(frame.buffer).setUint16(STREAM_ID_LENGTH_OFFSET, id.length, false);
  frame.set(id, STREAM_ID_OFFSET);
  frame.set(data, STREAM_ID_OFFSET + id.length);
  return frame;
}

export function decodeTerminalFrame(frame: Uint8Array): TerminalFrame {
  if (frame.length < STREAM_ID_OFFSET) throw new FrameError("frame shorter than its header");
  if (frame[0] !== STREAM_FRAME.DATA) throw new FrameError(`unknown opcode ${frame[0]}`);

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const idLength = view.getUint16(STREAM_ID_LENGTH_OFFSET, false);
  if (frame.length < STREAM_ID_OFFSET + idLength) throw new FrameError("truncated stream id");

  const streamId = new TextDecoder("ascii").decode(
    frame.subarray(STREAM_ID_OFFSET, STREAM_ID_OFFSET + idLength),
  );
  // subarray, not slice: the payload is handed straight to xterm.js and there is
  // no reason to copy a terminal's worth of bytes on every frame.
  return { streamId, data: frame.subarray(STREAM_ID_OFFSET + idLength) };
}

/** Client → server stdin. No stream id: keystrokes have no position. */
export function encodeStdinFrame(data: Uint8Array): Uint8Array {
  return encodeTerminalFrame("", data);
}
