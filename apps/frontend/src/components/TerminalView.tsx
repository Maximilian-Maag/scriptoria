"use client";

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { isLiveStatus, type StreamStatus } from "@scriptoria/contracts";
import { useTerminalStream } from "@/lib/terminal/useTerminalStream";

/**
 * FA-07 — the terminal.
 *
 * xterm.js rather than a `<pre>`, because the scripts emit real ANSI: colour,
 * cursor positioning, progress redraws. A hand-rolled output pane renders those
 * as garbage, and the interactive dialogues are exactly where it would show.
 *
 * FA-07.5 is worth keeping in mind while reading this file: a terminal that
 * stays empty is not an error. Many scripts deliberately produce no output at
 * all, and nothing here may render that as a fault.
 */

/** NFR-09: the whole run has to stay scrollable, not the last screen of it. */
const SCROLLBACK_LINES = 100_000;

export function TerminalView({
  runId,
  live,
  transcript,
  onStatus,
}: {
  runId: string;
  /** False for a run that is already over — its history comes from the transcript. */
  live: boolean;
  transcript: Uint8Array | null;
  onStatus?: (status: StreamStatus) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;

    // Imported at mount rather than at module scope: xterm.js touches `window`
    // on the way in, and this page is server-rendered first.
    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (disposed || !host.current) return;

      const term = new XTerm({
        scrollback: SCROLLBACK_LINES,
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        lineHeight: 1.3,
        cursorBlink: true,
        // FA-07.3: the output has to be selectable and copyable, to carry it
        // straight into another system.
        rightClickSelectsWord: true,
        theme: {
          background: "#111827",
          foreground: "#e5e7eb",
          cursor: "#e5e7eb",
          selectionBackground: "#374151",
        },
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(host.current);
      fit.fit();

      const onWindowResize = () => fit.fit();
      window.addEventListener("resize", onWindowResize);

      setTerminal(term);
      cleanup = () => {
        window.removeEventListener("resize", onWindowResize);
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  // FA-07.2 — a run that is over is read from the durable copy of its terminal
  // rather than from the live stream, which is capped and expires.
  useEffect(() => {
    if (!terminal || !transcript || transcript.length === 0) return;
    terminal.write(transcript);
  }, [terminal, transcript]);

  const stream = useTerminalStream(terminal, runId, {
    enabled: live,
    ...(onStatus ? { onStatus } : {}),
  });

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-terminal-bg">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-white/45">
          terminal
        </span>
        {live ? <ConnectionDot connected={stream.connected} /> : null}
      </div>
      <div ref={host} className="min-h-0 flex-1 p-2" />
    </div>
  );
}

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-white/45">
      <span
        className={`size-1.5 rounded-full ${connected ? "bg-state-succeeded" : "bg-state-failed"}`}
      />
      {/* A dropped socket says so and keeps retrying; the run itself is not
          affected by it, and the wording has to make that clear. */}
      {connected ? "streaming" : "reconnecting"}
    </span>
  );
}

/**
 * Whether a run is still going — which is what decides where this view's bytes
 * come from: a socket while it is, the durable transcript once it is not
 * (FA-07.2). The classification is the contract's, and not a list kept here:
 * it is a shared rule, and a second copy of it in the interface is one that can
 * disagree with the state machine it is describing.
 */
export const isLive = isLiveStatus;
