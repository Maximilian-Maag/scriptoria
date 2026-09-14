import { z } from "zod";
import { defineConfig, intFromEnv, boolFromEnv, nonEmpty } from "./load";
import { sharedSchema } from "./shared";
import { redisSchema } from "./redis";

const ldapSchema = z.object({
  /**
   * NFR-02: LDAPS in production. The dev fixture speaks plain LDAP, so the
   * scheme is configurable rather than hard-wired — but see LDAP_TLS_REJECT_
   * UNAUTHORIZED below, which is the setting that actually decides whether the
   * connection is worth anything.
   */
  LDAP_URL: nonEmpty.default("ldap://localhost:1389"),
  LDAP_BASE_DN: nonEmpty.default("dc=scriptoria,dc=test"),

  /**
   * How a username becomes a bind DN. The auth service binds with the USER's own
   * credentials (never a stored password), so it has to construct their DN from
   * what they typed. `{username}` is the only placeholder.
   */
  LDAP_USER_DN_TEMPLATE: nonEmpty.default("cn={username},ou=users,dc=scriptoria,dc=test"),

  /**
   * The read-only service account, used for group resolution only. It never
   * authenticates anybody: a user proves who they are by binding themselves.
   */
  LDAP_BIND_DN: nonEmpty.default("cn=admin,dc=scriptoria,dc=test"),
  LDAP_BIND_PASSWORD: nonEmpty.default("adminpassword"),

  LDAP_GROUP_SEARCH_BASE: nonEmpty.default("ou=groups,dc=scriptoria,dc=test"),
  /** `{userDn}` is substituted with the DN that just bound successfully. */
  LDAP_GROUP_FILTER: nonEmpty.default("(&(objectClass=groupOfNames)(member={userDn}))"),

  /**
   * Off only against the dev fixture, where a self-signed chain would be testing
   * the fixture's certificate rather than anything real. In a real deployment this
   * is on and the organisation's own CA root is what validates it.
   */
  LDAP_TLS_REJECT_UNAUTHORIZED: boolFromEnv.default("true"),
  LDAP_TIMEOUT_MS: intFromEnv({ min: 500 }).default(10_000),
});

const sessionSchema = z.object({
  SESSION_COOKIE_NAME: nonEmpty.default("scriptoria.sid"),

  /**
   * Idle rather than absolute, because the people using this are working through
   * a script that may block on a prompt for minutes at a time. An absolute
   * timeout in the middle of a modifying run is worse than the risk it mitigates.
   */
  SESSION_IDLE_TIMEOUT_SECONDS: intFromEnv({ min: 300 }).default(3600),
  /** The outer bound regardless of activity. A working day, not a week. */
  SESSION_ABSOLUTE_TIMEOUT_SECONDS: intFromEnv({ min: 3600 }).default(43_200),

  /** Off only over plain http in development. Never off behind TLS. */
  SESSION_COOKIE_SECURE: boolFromEnv.default("true"),
});

export const backendSchema = sharedSchema
  .merge(redisSchema)
  .merge(ldapSchema)
  .merge(sessionSchema)
  .extend({
    BACKEND_PORT: intFromEnv({ min: 1, max: 65_535 }).default(3001),
    /** Where the frontend's proxy and the browser's WebSocket both arrive. */
    BACKEND_PUBLIC_ORIGIN: z.string().url().default("http://localhost:3001"),

    DATABASE_URL: z
      .string()
      .url()
      .default("postgres://postgres:postgres@localhost:5432/scriptoria"),
    DATABASE_POOL_MAX: intFromEnv({ min: 1 }).default(10),

    /**
     * Script metadata is read off the script VM and cached (ADR-004). Short,
     * because a script owner who edits a header expects to see it, and listing a
     * directory over an already-open SSH connection is cheap.
     */
    CATALOG_CACHE_TTL_SECONDS: intFromEnv({ min: 0 }).default(60),
  });

export const loadBackendConfig = defineConfig("backend", backendSchema);
export type BackendConfig = z.infer<typeof backendSchema>;
