/**
 * The end-to-end suite's view of the world it runs against.
 *
 * Everything here is a *default* that matches `infra/docker-compose.dev.yml`
 * and the defaults in `packages/config`, and every one of them can be
 * overridden from the environment — which is what lets CI point the suite at
 * the same ports a fresh `make dev` opens and an operator point it at a
 * deployment without editing a file.
 *
 * The suite deliberately does not import `@scriptoria/config`. That package
 * validates the *application's* environment (NODE_ENV, secrets, service
 * manager values) and would fail here for reasons that have nothing to do with
 * the browser; more importantly, a suite that reads its target from the same
 * place the application reads its own cannot catch the case where the two
 * disagree, which is exactly the class of bug an end-to-end run exists to find.
 */

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

/** Where the browser goes. The frontend, never the control plane (ADR-007). */
export const BASE_URL = env("E2E_BASE_URL", "http://localhost:3000");

/** The control plane's own address, for the WebSocket the browser opens directly. */
export const BACKEND_ORIGIN = env("E2E_BACKEND_ORIGIN", "http://localhost:3001");

/**
 * The directory fixture's four accounts (infra/openldap/ldifs/00-users.ldif).
 *
 * Four because the authorisation rules need four distinct shapes: a root
 * account, an account entitled to two areas, one entitled to a single area, and
 * one entitled to nothing at all.
 */
export const ACCOUNTS = {
  root: { username: env("E2E_ROOT_USER", "platform.root"), password: env("E2E_PASSWORD", "Passw0rd!") },
  branch: {
    username: env("E2E_BRANCH_USER", "admin.branch"),
    password: env("E2E_PASSWORD", "Passw0rd!"),
  },
  datacenter: {
    username: env("E2E_DATACENTER_USER", "admin.datacenter"),
    password: env("E2E_PASSWORD", "Passw0rd!"),
  },
  none: { username: env("E2E_NONE_USER", "admin.none"), password: env("E2E_PASSWORD", "Passw0rd!") },
} as const;

/** The directory groups the fixture maps onto areas (FA-11, NFR-03). */
export const GROUPS = {
  root: env("E2E_ROOT_GROUP", "scriptoria-root"),
  branchNetwork: env("E2E_BRANCH_GROUP", "scriptoria-branch-network"),
  firewall: env("E2E_FIREWALL_GROUP", "scriptoria-firewall"),
  datacenter: env("E2E_DATACENTER_GROUP", "scriptoria-datacenter"),
} as const;

/** The two fixture scripts (infra/sshd/scripts). */
export const SCRIPTS = {
  /** Read-only, non-interactive: runs to the end and writes four CSVs. */
  inventory: { fileName: "inventory-report.sh", title: "Interface inventory (fixture)" },
  /** Modifying, interactive: loops over sites and blocks on `read`. */
  rollout: { fileName: "site-rollout.sh", title: "Site rollout (fixture)" },
  /**
   * Read-only and deliberately long-running: FA-08.3 stops a read-only script
   * *immediately*, which can only be observed while it is still going.
   */
  watch: { fileName: "fixture-watch.sh", title: "Long watch (fixture)" },
} as const;

/**
 * The script-VM fixture's export directory, as the scripts themselves see it.
 * Runs write into a date-stamped directory beneath it (FA-09).
 */
export const EXPORT_ROOT = env("E2E_EXPORT_ROOT", "/opt/scriptoria/export");

/** What the seed creates: the reference area and the group entitled to it. */
export const REFERENCE_AREA = {
  name: env("E2E_AREA_NAME", "Branch Network"),
  directoryGroup: GROUPS.branchNetwork,
};

/** Services the suite cannot run without. Checked in global setup. */
export const REQUIRED_SERVICES = [
  { name: "postgres (dev stack)", host: env("E2E_PG_HOST", "localhost"), port: Number(env("E2E_PG_PORT", "5433")) },
  { name: "redis (dev stack)", host: "localhost", port: Number(env("E2E_REDIS_PORT", "6379")) },
  { name: "openldap (directory fixture)", host: "localhost", port: Number(env("E2E_LDAP_PORT", "1389")) },
  { name: "sshd (script-VM fixture)", host: "localhost", port: Number(env("E2E_SSH_PORT", "2222")) },
] as const;
