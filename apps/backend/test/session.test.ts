import { describe, expect, it } from "vitest";
import { loadBackendConfig } from "@scriptoria/config";
import { clearedSessionCookie, sessionCookie } from "../src/lib/auth/session";

/**
 * The cookie's lifetime is not the session's lifetime, and confusing the two is
 * how an active operator gets signed out.
 *
 * The browser's cookie is a janitor: the authority is the session in Redis, whose
 * key carries the idle TTL that `readSession` slides on every request and whose
 * absolute deadline it enforces by itself. A cookie that expires at the idle
 * window signs out someone who has been working the whole time — their session is
 * alive, and no request is sent with a cookie that is gone.
 */

const config = loadBackendConfig();

describe("sessionCookie", () => {
  it("gives the browser the absolute lifetime, not the idle window", () => {
    // Without this the assertion below could hold for the wrong reason.
    expect(config.SESSION_ABSOLUTE_TIMEOUT_SECONDS).toBeGreaterThan(
      config.SESSION_IDLE_TIMEOUT_SECONDS,
    );

    // The login route calls this with no second argument, so this is the
    // browser's lifetime after signing in.
    const cookie = sessionCookie("session-id");

    expect(cookie).toContain(`Max-Age=${config.SESSION_ABSOLUTE_TIMEOUT_SECONDS}`);
    expect(cookie).not.toContain(`Max-Age=${config.SESSION_IDLE_TIMEOUT_SECONDS}`);
  });

  it("still lets a caller ask for a shorter lifetime", () => {
    expect(sessionCookie("session-id", 60)).toContain("Max-Age=60");
  });

  it("keeps the attributes the session design requires", () => {
    const cookie = sessionCookie("session-id");

    expect(cookie).toContain(`${config.SESSION_COOKIE_NAME}=session-id`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    // Nothing in this product is reached by following a link from elsewhere.
    expect(cookie).toContain("SameSite=Strict");
  });

  it("expires the cookie immediately at logout", () => {
    expect(clearedSessionCookie()).toContain("Max-Age=0");
  });
});
