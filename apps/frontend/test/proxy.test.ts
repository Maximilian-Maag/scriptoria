import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "../src/app/api/proxy/[...path]/route";

/**
 * The API proxy's header handling, from the browser's side of the wire.
 *
 * `fetch` decodes a compressed body for us and leaves `content-encoding` on the
 * headers, so a proxy that copies every header through tells the browser it is
 * being handed gzip while handing it plaintext. Nothing has to ask for
 * compression for this to matter: the Next.js tier, a reverse proxy or a CDN in
 * front of the control plane is enough.
 */

let upstream: Server;
let upstreamUrl = "";

beforeAll(async () => {
  upstream = createServer((request, response) => {
    if (request.url?.startsWith("/api/gzipped")) {
      const payload = JSON.stringify({ hello: "world" });
      const body = gzipSync(payload);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(body.length),
      });
      response.end(body);
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ plain: true }));
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const address = upstream.address();
  const port = typeof address === "object" && address ? address.port : 0;
  upstreamUrl = `http://127.0.0.1:${port}`;
  process.env["BACKEND_INTERNAL_URL"] = upstreamUrl;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const forward = (path: string) =>
  GET(new Request(`http://localhost:3000/api/proxy/${path}`), {
    params: Promise.resolve({ path: [path] }),
  });

describe("the API proxy", () => {
  it("does not claim a decoded body is still compressed", async () => {
    const response = await forward("gzipped");

    expect(response.status).toBe(200);
    // The upstream sent gzip; undici decoded it; the header must not survive
    // that, or a browser refuses to decode a response that is already plain.
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual({ hello: "world" });
  });

  it("passes an uncompressed response through unchanged", async () => {
    const response = await forward("plain");

    expect(await response.json()).toEqual({ plain: true });
  });
});
