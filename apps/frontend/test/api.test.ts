import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, api } from "../src/lib/api";

/**
 * The error path of the typed client.
 *
 * `call()` promises an `ApiFailure` for every non-2xx, and every caller in the
 * interface branches on it. The control plane's envelope is the common case, but
 * it is not the only one: anything between the browser and the control plane
 * that answers for itself — a reverse proxy, a load balancer, a crash page —
 * returns JSON of its own shape, and a client that assumes the envelope turns a
 * readable failure into a `TypeError`.
 */

function answering(status: number, body: unknown, contentType = "application/json"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(body === null ? "" : JSON.stringify(body), {
          status,
          headers: { "content-type": contentType },
        }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a non-2xx response", () => {
  it("becomes an ApiFailure carrying the status and the code", async () => {
    answering(403, { error: { code: "forbidden", message: "Not your area" } });

    const failure = await api.session().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure).toMatchObject({ status: 403, code: "forbidden", message: "Not your area" });
  });

  it("stays an ApiFailure when the body is not the control plane's envelope", async () => {
    // What a proxy in front of the control plane answers with. Reading
    // `body.error.code` here threw a TypeError instead, so the status and the
    // code were both lost and the interface showed a meaningless message.
    answering(401, { message: "Unauthorized" });

    const failure = await api.session().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure).toMatchObject({ status: 401, code: "internal", message: "Something went wrong" });
  });

  it("stays an ApiFailure when the body is not JSON at all", async () => {
    answering(502, null, "text/html");

    const failure = await api.session().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure).toMatchObject({ status: 502, code: "internal" });
  });
});