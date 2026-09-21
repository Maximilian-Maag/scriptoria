import { loadFrontendConfig } from "@scriptoria/config";

export const dynamic = "force-dynamic";

/**
 * The browser's only REST route to the control plane.
 *
 * Every call the interface makes arrives here and is forwarded server-side with
 * the session cookie attached. The browser never holds session material — the
 * cookie is `httpOnly`, so no script in the page can read it, and no script in
 * the page ever talks to the control plane directly.
 *
 * The one exception is the terminal WebSocket, which goes from the browser to
 * the control plane and bypasses this route entirely (ADR-007). A route handler
 * cannot hold a socket open for the life of a run, and that is the whole reason
 * the control plane has a custom server.
 *
 * Bodies are streamed rather than buffered, because one of the things that
 * comes through here is a result file (FA-09.2) and a result file can be large.
 */

/**
 * Hop-by-hop headers, plus the ones the fetch layer must set for itself.
 *
 * `content-length` AND `content-encoding`, for the same reason: `fetch` hands the
 * body back already decoded, so a copied `content-encoding: gzip` describes
 * bytes that are no longer gzipped. A browser that honours it fails to decode
 * the response at all, which is how a result file arrives as
 * `ERR_CONTENT_DECODING_FAILED` rather than as a download.
 */
const STRIPPED = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding",
]);

async function proxy(request: Request, path: string[]): Promise<Response> {
  const config = loadFrontendConfig();
  const target = new URL(`/api/${path.join("/")}`, config.BACKEND_INTERNAL_URL);
  target.search = new URL(request.url).search;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIPPED.has(key.toLowerCase())) headers.set(key, value);
  });

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(config.PROXY_TIMEOUT_MS),
    } as RequestInit);
  } catch (cause) {
    // The control plane being down is an ordinary outcome for this route, and
    // the error envelope is the same one every other failure uses so the
    // interface has exactly one error renderer.
    console.error("proxy failed", { path: path.join("/"), cause });
    return Response.json(
      {
        error: {
          code: "upstream_unavailable",
          message: "The control plane is not reachable",
        },
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED.has(key.toLowerCase())) responseHeaders.append(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return proxy(request, (await context.params).path);
}
export async function POST(request: Request, context: Context): Promise<Response> {
  return proxy(request, (await context.params).path);
}
export async function PUT(request: Request, context: Context): Promise<Response> {
  return proxy(request, (await context.params).path);
}
export async function PATCH(request: Request, context: Context): Promise<Response> {
  return proxy(request, (await context.params).path);
}
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return proxy(request, (await context.params).path);
}
