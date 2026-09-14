import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type Redis from "ioredis";
import {
  clientMessageSchema,
  isTerminalStatus,
  type ServerMessage,
  type StreamHello,
} from "@scriptoria/contracts";
import { canAccessArea, decodeTerminalFrame, encodeTerminalFrame } from "@scriptoria/core";
import { loadBackendConfig } from "@scriptoria/config";
import { readSession } from "../auth/session";
import { keys, redis, redisSubscriber } from "../redis";
import { findRunById } from "../db/repositories/runRepository";

/**
 * The terminal WebSocket (ADR-006, ADR-007).
 *
 * This is the one component that is not a route handler. A route handler cannot
 * hold a socket open for the life of a run, and a run is a stateful, possibly
 * minutes-long PTY session — so the gateway is mounted on the custom server that
 * hosts Next.js instead.
 *
 * It holds no PTY of its own. It reads the run's capped Redis stream and writes
 * chunks to the client; it takes the client's keystrokes and publishes them to
 * whichever worker holds the PTY. That indirection is what lets a deploy of this
 * app happen while a script is running.
 *
 * It is stateless per connection: everything it needs is the run id and the
 * client's last-seen stream id.
 */

const TERMINAL_PATH = "/terminal";
const READ_BLOCK_MS = 15_000;

const wss = new WebSocketServer({ noServer: true });

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function close(socket: WebSocket, message: ServerMessage): void {
  send(socket, message);
  socket.close();
}

/**
 * Authorises the upgrade before a socket exists.
 *
 * Rejecting here rather than after the handshake matters: an unauthorised client
 * that gets an open socket and then a close frame has still learned that the run
 * id is real. A 401 on the upgrade tells it nothing.
 */
export function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== TERMINAL_PATH) return false;

  wss.handleUpgrade(request, socket, head, (ws) => {
    void serve(ws, request).catch((cause) => {
      console.error("terminal gateway failed", cause);
      close(ws, { type: "end", reason: "server_shutdown", message: "The stream ended" });
    });
  });
  return true;
}

async function serve(socket: WebSocket, request: IncomingMessage): Promise<void> {
  const config = loadBackendConfig();

  const sessionId = cookieValue(request.headers.cookie, config.SESSION_COOKIE_NAME);
  const session = await readSession(sessionId);
  if (!session) {
    close(socket, { type: "end", reason: "unauthorised", message: "Not signed in" });
    return;
  }

  const hello = await firstMessage(socket);
  if (!hello) {
    close(socket, { type: "end", reason: "not_found", message: "No hello frame" });
    return;
  }

  const run = await findRunById(hello.runId);
  // Deliberately the same answer for a run that does not exist and a run in an
  // area this session is not entitled to. A distinguishable 403 would turn the
  // terminal endpoint into a way to enumerate other departments' runs.
  if (!run || !canAccessArea(session.areaIds, run.areaId)) {
    close(socket, { type: "end", reason: "not_found", message: "No such run" });
    return;
  }

  const streamKey = keys.runStream(run.id);
  const commands = redis();

  // A client that asks to resume from an id the capped stream has already
  // trimmed gets told so, rather than being silently handed a history with a
  // hole in it. Its terminal has to be cleared before the replay is rendered.
  let cursor = hello.lastStreamId ?? "0";
  let replayGap = false;
  if (hello.lastStreamId) {
    const [oldest] = await commands.xrange(streamKey, "-", "+", "COUNT", 1);
    const oldestId = oldest?.[0];
    if (oldestId && compareStreamIds(oldestId, hello.lastStreamId) > 0) {
      replayGap = true;
      cursor = "0";
    }
  }

  send(socket, { type: "ready", runId: run.id, status: run.status, replayGap });

  const stdin = wireStdin(socket, run.id);
  try {
    await pump(socket, streamKey, cursor, run.id);
  } finally {
    stdin.disconnect();
  }
}

/** Waits for the hello frame, and only the hello frame, before doing anything. */
function firstMessage(socket: WebSocket): Promise<StreamHello | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), 10_000);

    const onMessage = (raw: unknown): void => {
      try {
        const parsed = clientMessageSchema.safeParse(JSON.parse(String(raw)));
        finish(parsed.success && parsed.data.type === "hello" ? parsed.data : null);
      } catch {
        finish(null);
      }
    };

    const finish = (value: StreamHello | null): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(value);
    };

    socket.on("message", onMessage);
    socket.once("close", () => finish(null));
  });
}

/**
 * Keystrokes travel on a Redis channel keyed by run id, so they reach the one
 * worker holding this PTY wherever it happens to be running.
 */
function wireStdin(socket: WebSocket, runId: string): { disconnect: () => void } {
  const commands = redis();
  const channel = keys.runStdin(runId);

  const onMessage = (raw: unknown, isBinary: boolean): void => {
    if (!isBinary) return; // Control messages are handled elsewhere; resize lands here later.
    try {
      const { data } = decodeTerminalFrame(new Uint8Array(raw as ArrayBufferLike));
      if (data.length > 0) void commands.publish(channel, Buffer.from(data));
    } catch {
      // A malformed frame is a client bug. Dropping it is right: the alternative
      // is tearing down a live terminal over one bad keystroke.
    }
  };

  socket.on("message", onMessage);
  return { disconnect: () => socket.off("message", onMessage) };
}

/**
 * Reads the run's stream forward and writes each chunk to the client, blocking
 * on `XREAD` rather than polling. Ends when the run reaches a terminal state and
 * the stream has been drained — the terminal stays on screen, the socket does
 * not.
 */
async function pump(
  socket: WebSocket,
  streamKey: string,
  from: string,
  runId: string,
): Promise<void> {
  const reader: Redis = redisSubscriber();
  let cursor = from;

  try {
    while (socket.readyState === socket.OPEN) {
      // `xreadBuffer`, not `xread`. The default variant decodes replies as UTF-8
      // strings, which would corrupt the PTY bytes here — the exact failure
      // ADR-006 chose binary frames to avoid, one layer earlier.
      const response = (await reader.xreadBuffer(
        "BLOCK",
        READ_BLOCK_MS,
        "STREAMS",
        streamKey,
        cursor,
      )) as [Buffer, [Buffer, Buffer[]][]][] | null;

      if (response) {
        for (const [, entries] of response) {
          for (const [id, fields] of entries) {
            cursor = id.toString("ascii");
            const payload = fieldValue(fields, "d");
            if (payload) socket.send(encodeTerminalFrame(cursor, payload), { binary: true });
          }
        }
        continue;
      }

      // No new bytes within the block. That is normal for a script waiting on a
      // prompt, so it is only a reason to stop if the run is actually over.
      const run = await findRunById(runId);
      if (!run) break;
      if (isTerminalStatus(run.status)) {
        send(socket, {
          type: "status",
          status: run.status,
          exitCode: run.exitCode,
          failureReason: (run.failureReason as never) ?? null,
          abortStage: run.abortStage,
          at: new Date().toISOString(),
        });
        close(socket, { type: "end", reason: "finished", message: "The run has ended" });
        break;
      }
    }
  } finally {
    reader.disconnect();
  }
}

/**
 * ioredis hands a stream entry back as a flat `[field, value, field, value]`
 * array. The payload is written as a Buffer by the runner and must stay one.
 */
function fieldValue(fields: Buffer[], name: string): Uint8Array | null {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i]?.toString("ascii") === name) return fields[i + 1] ?? null;
  }
  return null;
}

/** Redis stream ids are `<millis>-<sequence>`, compared numerically in both parts. */
export function compareStreamIds(a: string, b: string): number {
  const [aMs = "0", aSeq = "0"] = a.split("-");
  const [bMs = "0", bSeq = "0"] = b.split("-");
  const ms = Number(aMs) - Number(bMs);
  return ms !== 0 ? ms : Number(aSeq) - Number(bSeq);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      const value = rest.join("=");
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}
