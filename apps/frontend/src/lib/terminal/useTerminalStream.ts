"use client";

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  serverMessageSchema,
  type RunStatus,
  type StreamEnd,
  type StreamStatus,
} from "@scriptoria/contracts";
import { decodeTerminalFrame, encodeStdinFrame } from "@scriptoria/core";

/**
 * ADR-006's client half: the run's terminal, live and bidirectional.
 *
 * Three things about it are not incidental.
 *
 *   · **The socket goes to the control plane directly**, not through the API
 *     proxy every other call uses. A route handler cannot hold a socket open
 *     for the life of a run (ADR-007), and a run can be minutes long.
 *   · **Binary frames are written into xterm.js as bytes.** They are never
 *     decoded to a string on the way: a PTY read splits multi-byte characters
 *     wherever the kernel happens to split them, and decoding per frame turns
 *     an umlaut in a script's output into two replacement characters.
 *   · **Every chunk carries its stream id**, so a reconnect asks for the gap
 *     rather than for the run. A browser reload mid-run loses nothing.
 */

const WS_BASE = process.env["NEXT_PUBLIC_TERMINAL_WS_URL"] ?? "ws://localhost:3001";

/** How long before a dropped connection is retried, and how often at most. */
const RECONNECT_DELAY_MS = 1_500;
const MAX_RECONNECTS = 20;

export interface TerminalStreamState {
  connected: boolean;
  status: RunStatus | null;
  exitCode: number | null;
  ended: StreamEnd | null;
}

export function useTerminalStream(
  terminal: Terminal | null,
  runId: string,
  options: { enabled: boolean; onStatus?: (status: StreamStatus) => void },
): TerminalStreamState {
  const [state, setState] = useState<TerminalStreamState>({
    connected: false,
    status: null,
    exitCode: null,
    ended: null,
  });

  // Kept in refs rather than state: a re-render must not reopen the socket, and
  // the resume position has to survive one.
  const lastStreamId = useRef<string | null>(null);
  const attempts = useRef(0);
  const closedByUs = useRef(false);
  const onStatus = useRef(options.onStatus);
  onStatus.current = options.onStatus;

  useEffect(() => {
    if (!terminal || !options.enabled) return;

    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    closedByUs.current = false;

    const connect = (): void => {
      socket = new WebSocket(`${WS_BASE}/terminal`);
      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        attempts.current = 0;
        setState((previous) => ({ ...previous, connected: true }));
        socket?.send(
          JSON.stringify({
            type: "hello",
            runId,
            lastStreamId: lastStreamId.current,
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") {
          const frame = decodeTerminalFrame(new Uint8Array(event.data as ArrayBuffer));
          if (frame.streamId) lastStreamId.current = frame.streamId;
          terminal.write(frame.data);
          return;
        }

        const parsed = serverMessageSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success) return;
        const message = parsed.data;

        if (message.type === "ready") {
          // The history this client holds and the history it is about to get do
          // not join up, so showing both would be showing a lie.
          if (message.replayGap) terminal.clear();
          setState((previous) => ({ ...previous, status: message.status }));
          return;
        }
        if (message.type === "status") {
          setState((previous) => ({
            ...previous,
            status: message.status,
            exitCode: message.exitCode,
          }));
          onStatus.current?.(message);
          return;
        }

        // `end` is the last message before the socket closes. The terminal
        // stays on screen and scrollable: the run is over, the output is not.
        closedByUs.current = true;
        setState((previous) => ({ ...previous, ended: message }));
      };

      socket.onclose = () => {
        setState((previous) => ({ ...previous, connected: false }));
        if (closedByUs.current || attempts.current >= MAX_RECONNECTS) return;
        attempts.current += 1;
        retry = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    connect();

    // Keystrokes go straight out as bytes. What the operator typed is the
    // script's business (FA-06.1), and nothing on this path parses it.
    const typed = terminal.onData((data) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(encodeStdinFrame(new TextEncoder().encode(data)));
    });

    const resized = terminal.onResize(({ cols, rows }) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "resize", cols, rows }));
    });

    return () => {
      closedByUs.current = true;
      if (retry) clearTimeout(retry);
      typed.dispose();
      resized.dispose();
      socket?.close();
    };
  }, [terminal, runId, options.enabled]);

  return state;
}
