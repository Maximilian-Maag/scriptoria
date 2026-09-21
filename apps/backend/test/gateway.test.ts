import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

/**
 * The terminal gateway's two rejection paths, and what they cost.
 *
 * An unauthenticated client must be answered on the upgrade rather than being
 * handed a socket, and a client that is rejected after the handshake must be let
 * go immediately — a paused socket cannot read the close frame, so closing one
 * without resuming it first holds a server-side connection for thirty seconds
 * and makes connection churn a way to exhaust the control plane's descriptors.
 */

const readSession = vi.fn();
const findRunById = vi.fn();

vi.mock("../src/lib/auth/session", () => ({ readSession }));
vi.mock("@scriptoria/db", () => ({ runRepository: { findRunById } }));
vi.mock("../src/lib/redis", () => ({
  keys: {
    runStream: (runId: string) => `run:${runId}:stream`,
    runStdin: (runId: string) => `run:${runId}:stdin`,
    runControl: (runId: string) => `run:${runId}:control`,
  },
  redis: () => ({ xrange: vi.fn(), publish: vi.fn() }),
  redisSubscriber: () => ({ xreadBuffer: vi.fn(), disconnect: vi.fn() }),
}));

const { handleUpgrade } = await import("../src/lib/stream/gateway");

const SESSION = {
  id: "session-id",
  username: "admin.branch",
  displayName: "Branch Admin",
  role: "administrator" as const,
  groups: [],
  areaIds: ["area-1"],
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  expiresAt: new Date(Date.now() + 3_600_000),
};

let server: Server;
let port = 0;

beforeEach(async () => {
  readSession.mockReset();
  findRunById.mockReset();

  server = createServer();
  server.on("upgrade", (request, socket, head) => {
    if (!handleUpgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterEach(async () => {
  // Unref'd sockets aside, this would hang if the gateway were still holding a
  // connection open — which is the failure this file exists to catch.
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the terminal upgrade", () => {
  it("answers an unauthenticated client without completing a handshake", async () => {
    readSession.mockResolvedValue(null);

    const response = await new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "GET /terminal HTTP/1.1\r\n" +
            `host: 127.0.0.1:${port}\r\n` +
            "connection: Upgrade\r\n" +
            "upgrade: websocket\r\n" +
            "sec-websocket-version: 13\r\n" +
            "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
      });
      let head = "";
      socket.on("data", (chunk) => {
        head += chunk.toString("utf8");
      });
      socket.on("close", () => resolve(head));
      socket.on("error", () => resolve(head));
    });

    expect(response).toContain("HTTP/1.1 401");
    expect(response).not.toContain("101 Switching Protocols");
  });

  it("lets a rejected socket go at once instead of holding it for thirty seconds", async () => {
    readSession.mockResolvedValue(SESSION);
    findRunById.mockResolvedValue(null); // no such run, or not entitled to it

    const started = Date.now();
    const client = new WebSocket(`ws://127.0.0.1:${port}/terminal`, {
      headers: { cookie: `scriptoria.sid=${SESSION.id}` },
    });

    const messages: unknown[] = [];
    client.on("message", (raw) => messages.push(JSON.parse(String(raw))));

    await new Promise<void>((resolve) => {
      client.on("close", () => resolve());
      client.on("error", () => resolve());
      client.on("open", () =>
        client.send(
          JSON.stringify({
            type: "hello",
            runId: "6f8c1d2e-0000-4000-8000-00000000000b",
            lastStreamId: null,
            cols: 80,
            rows: 24,
          }),
        ),
      );
    });
    const elapsed = Date.now() - started;

    expect(messages).toContainEqual({
      type: "end",
      reason: "not_found",
      message: "No such run",
    });
    // Thirty seconds is ws's close timeout; anything close to it means the
    // socket was closed while paused and the connection was held open.
    expect(elapsed).toBeLessThan(3_000);
  });
});
