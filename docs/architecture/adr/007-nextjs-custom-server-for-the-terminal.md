# ADR-007 — The backend runs a custom Next.js server so the terminal can use a real WebSocket

**Status:** Accepted
**Context:** NFR-08, NFR-11, FA-06, FA-07

## Context

NFR-11 mandates Next.js for the web application. NFR-08 requires bidirectional live streaming of
the terminal — stdin, stdout and stderr — as the precondition for the dialogue interaction in
FA-06.

These two pull against each other. A Next.js route handler is a request/response shape. It can
stream a response out, but it cannot hold a bidirectional socket open for the life of a run, and
a run can last from one second to well over a minute (NFR-10) with the user typing into it
throughout.

## Options

**A — A custom Node server hosting Next.js, with `ws` mounted alongside it (chosen).**
`server.ts` creates the HTTP server, hands ordinary requests to the Next.js request handler, and
attaches a WebSocket server on the `upgrade` event for `/ws/runs/:id`. One process, one port, one
framework. The build stays `output: "standalone"`; only the entrypoint is ours instead of the
generated `server.js`.

*For:* a real bidirectional socket, binary frames (which ADR-006 needs so PTY bytes are not
corrupted at multi-byte UTF-8 boundaries), one connection per run, and the session cookie
authorising the upgrade on the same origin.
*Against:* a custom server is a slightly off-path Next.js deployment. The standalone entrypoint
is hand-written, and some of Next.js's assumptions about owning the server no longer hold.

**B — Route handlers only: Server-Sent Events downstream, POST for stdin upstream.**
Pure Next.js, no custom server, deploys like any other Next.js application.

*For:* nothing off-path at all. For the line-oriented dialogues these scripts actually use —
*"Muss den Return drücken"* — the latency is fine.
*Against:* two half-duplex channels standing in for one duplex channel, which is a workaround for
NFR-08 rather than an implementation of it. SSE is a text protocol, so the PTY's raw bytes have
to be base64-encoded to survive it. And it forecloses any script that is genuinely
character-interactive.

**C — Put the WebSocket in a separate small service.** Rejected quickly: it splits authorisation
across two codebases, which for a system like this is the mistake the architecture is most careful
to avoid elsewhere.

## Decision

Option A. NFR-08 says bidirectional, and a duplex socket is what that means; NFR-11 says Next.js,
and a custom server is still Next.js. The cost is confined to one file and the container
entrypoint.

## Consequences

- `apps/backend` starts with `node server.js` (built from `server.ts`), not the standalone
  `server.js` Next.js generates. The Dockerfile and the systemd unit both point at ours.
- nginx upgrades `/ws/*` to this process. The matching rule sits above the general `/api/` rule,
  as does the frontend's `/api/proxy` prefix.
- The WebSocket authorises on upgrade against the same `httpOnly` session cookie the REST calls
  use, so there is one session mechanism and no token in browser JavaScript.
- The stream gateway holds no PTY — it reads the run's Redis stream and publishes stdin to the
  run's channel. That is what lets a backend replica be replaced mid-run without ending a
  terminal, and it is why option C bought nothing.
- **If the custom server turns out to be unacceptable operationally**, option B is the fallback
  and it is a contained change: the stream gateway's two directions become one SSE route and one
  POST route, and the client hook swaps its transport. Nothing else in the architecture moves.
