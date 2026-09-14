import { z } from "zod";
import { abortStageSchema, runStatusSchema, runFailureReasonSchema } from "./run";

/**
 * The terminal WebSocket protocol (ADR-006, ADR-007).
 *
 * Two frame types, and the split is the whole design:
 *
 *   · **Binary frames carry terminal bytes.** Raw, never decoded to a string on
 *     the way through. A PTY read boundary falls wherever the kernel puts it,
 *     which is routinely in the middle of a multi-byte UTF-8 sequence; decoding
 *     per frame turns a German umlaut in a script's output into two replacement
 *     characters. The bytes go into xterm.js exactly as they came off the PTY.
 *
 *   · **Text frames carry JSON control messages.** Status changes, the resume
 *     handshake, resize, errors. Small, structured, and safe to decode.
 *
 * A client distinguishes them by `typeof event.data`, not by a flag inside the
 * payload — which is why this can never accidentally be one channel.
 */

/** Binary frame layout, server → client and client → server. */
export const STREAM_FRAME = {
  /** Terminal bytes. Server → client: PTY output. Client → server: stdin. */
  DATA: 0x01,
} as const;

/**
 * Server → client binary frame:
 *
 *   byte 0        opcode (STREAM_FRAME.DATA)
 *   byte 1..2     big-endian length of the stream id, in bytes
 *   byte 3..3+n   the Redis stream id as ASCII ("1736899200000-0")
 *   rest          the raw PTY bytes
 *
 * The id travels with every chunk so that a client which drops its connection
 * knows exactly where it got to, and can ask for the gap rather than the run.
 *
 * Client → server binary frame: opcode, then a zero id length, then the stdin
 * bytes. The id field is kept so both directions decode with one function.
 */
export const STREAM_ID_LENGTH_OFFSET = 1;
export const STREAM_ID_OFFSET = 3;

/** Client → server, on connect. The only message that may precede the stream. */
export const streamHelloSchema = z.object({
  type: z.literal("hello"),
  runId: z.string().uuid(),
  /**
   * The last stream id this client rendered, or `null` on a first connection.
   * The gateway replays from here forward, so a browser reload or a brief
   * network drop loses nothing — which is also how NFR-09's full-run scrollback
   * is served without keeping the whole run in browser memory.
   */
  lastStreamId: z.string().nullable(),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});
export type StreamHello = z.infer<typeof streamHelloSchema>;

export const streamResizeSchema = z.object({
  type: z.literal("resize"),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});
export type StreamResize = z.infer<typeof streamResizeSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  streamHelloSchema,
  streamResizeSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Server → client, once the upgrade is authorised and the stream is positioned. */
export const streamReadySchema = z.object({
  type: z.literal("ready"),
  runId: z.string().uuid(),
  status: runStatusSchema,
  /**
   * True when the client's `lastStreamId` had already been trimmed out of the
   * capped stream. The client must clear its terminal before rendering what
   * follows, because the history it holds and the history it is about to get do
   * not join up.
   */
  replayGap: z.boolean(),
});
export type StreamReady = z.infer<typeof streamReadySchema>;

/** Server → client. Drives the status line above the terminal (FA-07.4). */
export const streamStatusSchema = z.object({
  type: z.literal("status"),
  status: runStatusSchema,
  exitCode: z.number().int().nullable(),
  failureReason: runFailureReasonSchema.nullable(),
  /** Set while an abort is escalating, so the UI can say which stage it is at. */
  abortStage: abortStageSchema.nullable(),
  at: z.string().datetime({ offset: true }),
});
export type StreamStatus = z.infer<typeof streamStatusSchema>;

/**
 * Server → client, last message before the socket closes. `finished` is the
 * normal end: the process exited and the stream is complete. The terminal stays
 * on screen and scrollable — the run is over, the output is not.
 */
export const streamEndSchema = z.object({
  type: z.literal("end"),
  reason: z.enum(["finished", "unauthorised", "not_found", "superseded", "server_shutdown"]),
  message: z.string(),
});
export type StreamEnd = z.infer<typeof streamEndSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  streamReadySchema,
  streamStatusSchema,
  streamEndSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
