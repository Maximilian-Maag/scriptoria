import { describe, expect, it } from "vitest";
import { clientAddressFor } from "../src/lib/http/clientAddress";

/**
 * FA-12.1 records where an action came from. Every case here is the same
 * question: can the caller choose its own entry in the audit trail?
 */
describe("clientAddressFor behind a reverse proxy", () => {
  const behindProxy = { trustedReverseProxy: true };

  it("uses the address the platform's own reverse proxy appended, not the client's", () => {
    // What nginx sends on: the client's invented prefix, then what nginx saw.
    expect(clientAddressFor("203.0.113.7, 198.51.100.24", "127.0.0.1", behindProxy)).toBe(
      "198.51.100.24",
    );
  });

  it("ignores a client-supplied prefix however long it is", () => {
    expect(clientAddressFor("10.1.2.3, 10.4.5.6, 192.0.2.9", "127.0.0.1", behindProxy)).toBe(
      "192.0.2.9",
    );
  });

  it("falls back to the connection when the proxy sent no header", () => {
    expect(clientAddressFor(undefined, "192.0.2.55", behindProxy)).toBe("192.0.2.55");
    expect(clientAddressFor(" ,  ", "192.0.2.55", behindProxy)).toBe("192.0.2.55");
  });

  it("accepts a repeated header, which Node hands over as an array", () => {
    expect(clientAddressFor(["203.0.113.7", "198.51.100.24"], "127.0.0.1", behindProxy)).toBe(
      "198.51.100.24",
    );
  });
});

describe("clientAddressFor with nothing in front of it", () => {
  const noProxy = { trustedReverseProxy: false };

  /**
   * The rule that closes the hole in the dev stack, where a browser reaches the
   * frontend directly: there, `x-forwarded-for` can only have been written by the
   * caller, so it is not read at all.
   */
  it("believes the connection, not a forwarded header the caller wrote", () => {
    expect(clientAddressFor("203.0.113.7, 198.51.100.24", "127.0.0.1", noProxy)).toBe("127.0.0.1");
  });

  it("has nothing to record when there is neither header nor socket", () => {
    expect(clientAddressFor("203.0.113.7", undefined, noProxy)).toBeNull();
  });
});

describe("clientAddressFor address spelling", () => {
  it("normalises the IPv4-in-IPv6 form a dual-stack socket reports", () => {
    expect(
      clientAddressFor(undefined, "::ffff:192.0.2.55", { trustedReverseProxy: false }),
    ).toBe("192.0.2.55");
    expect(
      clientAddressFor("::ffff:198.51.100.24", undefined, { trustedReverseProxy: true }),
    ).toBe("198.51.100.24");
  });
});
