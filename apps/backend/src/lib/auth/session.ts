import { randomBytes, timingSafeEqual } from "node:crypto";
import { loadBackendConfig } from "@scriptoria/config";
import type { Role } from "@scriptoria/contracts";
import { keys, redis } from "../redis";

/**
 * Server-side sessions in Redis, behind an opaque id in an httpOnly cookie.
 *
 * Deliberately not a JWT. NFR-03 requires that entitlement can be revoked at
 * runtime — an admin removes a group mapping and the affected sessions must stop
 * seeing the area. A self-contained token cannot do that: it is valid until it
 * expires, by construction. A server-side session can be rewritten or deleted,
 * which is the whole requirement.
 *
 * The cookie is `httpOnly`, so no session material ever reaches browser
 * JavaScript. That is also why every REST call goes through the frontend's
 * proxy rather than from the browser to this app directly.
 */

export interface SessionData {
  username: string;
  displayName: string;
  role: Role;
  /** As AD reported them at this login, and discarded at the next one. */
  groups: string[];
  /** Resolved from the group mapping. Empty is valid (FA-01.4). */
  areaIds: string[];
  createdAt: number;
  lastSeenAt: number;
}

export interface Session extends SessionData {
  id: string;
  expiresAt: Date;
}

const SESSION_ID_BYTES = 32;

export function newSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString("base64url");
}

/**
 * Compares two session ids in constant time. Used where an id from a request is
 * matched against one the server already holds — not for the Redis lookup, which
 * is a hash read and not a comparison.
 */
export function sessionIdEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function createSession(data: Omit<SessionData, "createdAt" | "lastSeenAt">) {
  const config = loadBackendConfig();
  const id = newSessionId();
  const now = Date.now();
  const payload: SessionData = { ...data, createdAt: now, lastSeenAt: now };

  await redis().set(
    keys.session(id),
    JSON.stringify(payload),
    "EX",
    config.SESSION_IDLE_TIMEOUT_SECONDS,
  );

  return {
    id,
    ...payload,
    expiresAt: new Date(now + config.SESSION_IDLE_TIMEOUT_SECONDS * 1000),
  } satisfies Session;
}

/**
 * Reads a session and slides its idle window.
 *
 * The absolute lifetime is checked here rather than left to Redis, because the
 * idle refresh would otherwise extend a session forever. An idle timeout with no
 * outer bound is not a timeout.
 */
export async function readSession(id: string | undefined): Promise<Session | null> {
  if (!id) return null;
  const config = loadBackendConfig();

  const raw = await redis().get(keys.session(id));
  if (!raw) return null;

  let data: SessionData;
  try {
    data = JSON.parse(raw) as SessionData;
  } catch {
    await destroySession(id);
    return null;
  }

  const now = Date.now();
  if (now - data.createdAt > config.SESSION_ABSOLUTE_TIMEOUT_SECONDS * 1000) {
    await destroySession(id);
    return null;
  }

  data.lastSeenAt = now;
  await redis().set(
    keys.session(id),
    JSON.stringify(data),
    "EX",
    config.SESSION_IDLE_TIMEOUT_SECONDS,
  );

  return {
    id,
    ...data,
    expiresAt: new Date(now + config.SESSION_IDLE_TIMEOUT_SECONDS * 1000),
  };
}

/**
 * Rewrites the entitlements of a live session. This is the function NFR-03 is
 * about: an admin revokes a group mapping and the sessions holding it lose the
 * area without being logged out.
 */
export async function updateSessionAreas(id: string, areaIds: string[]): Promise<void> {
  const config = loadBackendConfig();
  const raw = await redis().get(keys.session(id));
  if (!raw) return;

  const data = JSON.parse(raw) as SessionData;
  data.areaIds = areaIds;
  await redis().set(
    keys.session(id),
    JSON.stringify(data),
    "EX",
    config.SESSION_IDLE_TIMEOUT_SECONDS,
  );
}

/**
 * Every live session, as stored. The input to NFR-03's administrative sweep:
 * an admin changed a mapping, and the sessions that resolved their areas
 * against the old one have to be re-resolved against the new.
 *
 * Deliberately *not* built on `readSession`. That function slides the idle
 * window, and a sweep triggered by one administrator editing an area must not
 * silently keep every other operator's session alive. This reads without
 * touching a TTL.
 *
 * `SCAN` rather than `KEYS` because `KEYS` blocks the server for the length of
 * the keyspace, and this runs on an interactive request.
 */
export async function scanSessions(): Promise<{ id: string; data: SessionData }[]> {
  const prefix = keys.session("");
  const client = redis();
  const sessions: { id: string; data: SessionData }[] = [];

  let cursor = "0";
  do {
    const [next, batch] = await client.scan(cursor, "MATCH", keys.sessionScan, "COUNT", 200);
    cursor = next;
    if (batch.length === 0) continue;

    // One round trip per batch. A session that expired between the scan and
    // this read comes back null, which is not a problem worth reporting: it is
    // gone, and gone sessions are exactly what the sweep does not need to fix.
    const raws = await client.mget(batch);
    for (const [index, raw] of raws.entries()) {
      if (!raw) continue;
      const key = batch[index]!;
      try {
        sessions.push({ id: key.slice(prefix.length), data: JSON.parse(raw) as SessionData });
      } catch {
        // A session that will not parse cannot be re-entitled. `readSession`
        // destroys these when their owner next appears; the sweep steps over it.
      }
    }
  } while (cursor !== "0");

  return sessions;
}

export async function destroySession(id: string): Promise<void> {
  await redis().del(keys.session(id));
}

/**
 * The cookie, with the attributes NFR-02 and the session design require.
 *
 * `Max-Age` is the **absolute** lifetime, not the idle window. The browser's copy
 * is a janitor; the authority is the session in Redis, and the two were disagreeing
 * in the direction that signs people out. With the idle window here, an operator
 * who was working continuously lost the cookie after
 * `SESSION_IDLE_TIMEOUT_SECONDS` while the session it pointed at — slid forward by
 * every request — was still alive, and the absolute timeout that exists to be the
 * outer bound was never the thing that ended a session, because the cookie always
 * died first. The login route calls this with no second argument, so this default
 * *is* the browser's lifetime.
 *
 * Inactivity is enforced where it can be enforced honestly: the Redis key carries
 * the idle TTL, and `readSession` stops sliding it at the absolute deadline. A
 * browser that holds a cookie past either of those gets a 401, which is the same
 * answer it would have got with no cookie at all.
 */
export function sessionCookie(id: string, maxAgeSeconds?: number): string {
  const config = loadBackendConfig();
  const parts = [
    `${config.SESSION_COOKIE_NAME}=${id}`,
    "Path=/",
    "HttpOnly",
    // Strict rather than Lax: nothing in this product is reached by following a
    // link from somewhere else, so there is no flow Strict would break.
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds ?? config.SESSION_ABSOLUTE_TIMEOUT_SECONDS}`,
  ];
  if (config.SESSION_COOKIE_SECURE) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie(): string {
  return sessionCookie("", 0);
}

/** Pulls the session id out of a raw `Cookie` header, wherever it sits. */
export function sessionIdFromCookieHeader(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const name = loadBackendConfig().SESSION_COOKIE_NAME;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      const value = rest.join("=");
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}
