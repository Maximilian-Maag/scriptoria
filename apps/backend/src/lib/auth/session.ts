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

export async function destroySession(id: string): Promise<void> {
  await redis().del(keys.session(id));
}

/** The cookie, with the attributes NFR-02 and the session design require. */
export function sessionCookie(id: string, maxAgeSeconds?: number): string {
  const config = loadBackendConfig();
  const parts = [
    `${config.SESSION_COOKIE_NAME}=${id}`,
    "Path=/",
    "HttpOnly",
    // Strict rather than Lax: nothing in this product is reached by following a
    // link from somewhere else, so there is no flow Strict would break.
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds ?? config.SESSION_IDLE_TIMEOUT_SECONDS}`,
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
