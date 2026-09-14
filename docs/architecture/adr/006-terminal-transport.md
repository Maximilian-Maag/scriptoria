# ADR-006 — Terminal bytes travel through a capped Redis stream and binary WebSocket frames

**Status:** Accepted
**Context:** NFR-08, NFR-09, FA-07

## Context

The terminal is the product's critical path. It has to be bidirectional and live (NFR-08), hold
the complete run history to the end (NFR-09), survive a browser reload, and render the ANSI
escapes, colours and cursor movement that the existing interactive dialogues emit.

## Decision

**On the wire between the runner and the browser:** the runner appends the PTY's raw bytes to a
Redis stream per run, capped with `MAXLEN`. The stream gateway in the control plane reads that
stream and forwards the chunks over the WebSocket. Keystrokes travel the other way on a Redis
channel keyed by run id, so they reach the one worker holding that PTY.

**On the WebSocket:** binary frames, not text. The bytes are written into xterm.js as a
`Uint8Array` without being decoded first.

**In the browser:** xterm.js with the fit and web-links addons and `scrollback` raised well
above the default.

## Why each part

- **Redis in the middle, rather than the runner holding the socket.** It decouples the PTY's
  lifetime from the browser connection: a reload or a brief network drop loses nothing, because
  the client reconnects with the last stream id it saw and the gap is replayed. It also means
  any control-plane replica can serve any run, so a redeploy does not end a terminal.
- **Binary frames, specifically.** A PTY read can split a multi-byte UTF-8 sequence across two
  chunks. Decoding each chunk to a string independently corrupts the character at the boundary —
  visible as replacement characters in the middle of otherwise fine output, intermittently, and
  usually only under load. xterm.js accepts bytes and handles the boundary itself. This is a
  small decision that is very annoying to discover later.
- **xterm.js rather than rendering into a `<pre>`.** The scripts emit real ANSI: colour, cursor
  positioning, progress redraws. A hand-rolled output pane renders those as garbage, and the
  interactive dialogues are exactly where it would show.
- **The buffer is not in browser memory.** NFR-09 asks for the whole run to be available; the
  stream holds it and the browser holds a window onto it.

## Consequences

- `MAXLEN` and the retention of a finished run's stream are configuration. A run that finishes
  has its terminal history persisted once, so the stream can expire without losing FA-07.2.
- The stream gateway is stateless per connection: everything it needs is the run id and the
  client's last-seen stream id.
- Terminal and result stay two separate channels with different lifecycles, which is the
  distinction the product owner insisted on and the one FA-07 records.
