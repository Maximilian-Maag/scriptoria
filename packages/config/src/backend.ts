import { z } from "zod";
import { defineConfig, intFromEnv, boolFromEnv, nonEmpty } from "./load";
import { sharedSchema } from "./shared";
import { redisSchema } from "./redis";
import { databaseSchema } from "./database";

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
  .merge(databaseSchema)
  .merge(ldapSchema)
  .merge(sessionSchema)
  .extend({
    BACKEND_PORT: intFromEnv({ min: 1, max: 65_535 }).default(3001),
    /** Where the frontend's proxy and the browser's WebSocket both arrive. */
    BACKEND_PUBLIC_ORIGIN: z.string().url().default("http://localhost:3001"),

    /**
     * Script metadata is read off the script VM and cached (ADR-004). Short,
     * because a script owner who edits a header expects to see it, and listing a
     * directory over an already-open SSH connection is cheap.
     */
    CATALOG_CACHE_TTL_SECONDS: intFromEnv({ min: 0 }).default(60),

    /**
     * O-7 / ADR-013 — how many runs one script VM carries at once.
     *
     * One, because the scripts were written for sequential manual use and none
     * of them promises that two copies can share an output directory, a lock or
     * a site list. The number is configuration rather than a constant because it
     * is the script owner's to answer, per VM, and because the fixture used in
     * the tests is not the production one: a deployment whose VM is known to
     * tolerate more raises this and nothing else changes.
     */
    MAX_CONCURRENT_RUNS_PER_HOST: intFromEnv({ min: 1, max: 64 }).default(1),

    /**
     * How often the control plane looks for work a busy script VM held back.
     *
     * This is also the delay an operator sees between a running script ending
     * and the next queued one starting, so it is short. A start attempt dispatches
     * immediately as well; the sweep exists for the runs that were waiting.
     */
    DISPATCH_SWEEP_MS: intFromEnv({ min: 250 }).default(5_000),

    /**
     * O-5 / ADR-014 — how many days a finished run's terminal transcript is kept.
     *
     * Ninety, which is what the requirement proposed: the transcript is the only
     * thing in the database that grows without bound, and run and audit records are
     * small enough to keep for ever. **Zero keeps everything**, which is the shape a
     * deployment gets when nobody has decided — keeping data is the safe default,
     * and a customer who needs ten years changes this line.
     */
    TRANSCRIPT_RETENTION_DAYS: intFromEnv({ min: 0 }).default(90),

    /**
     * How often the transcript sweep runs. Hours rather than seconds: the thing it
     * deletes is already months old, so the interval only decides how long a
     * pruned-and-unswept gap can be, and a query every few seconds would be noise.
     */
    RETENTION_SWEEP_MS: intFromEnv({ min: 60_000 }).default(6 * 60 * 60_000),
  });

export const loadBackendConfig = defineConfig("backend", backendSchema);
export type BackendConfig = z.infer<typeof backendSchema>;
