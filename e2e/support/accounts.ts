/**
 * The seeded directory accounts, and what each one is for.
 *
 * They are not interchangeable. Every one of them exists to make a specific
 * requirement testable, and using the wrong one turns a real assertion into a
 * tautology — `none` in particular is the whole of FA-01.4.
 */
export const ACCOUNTS = {
  /** FA-11: the only account platform administration answers. */
  root: { username: "platform.root", password: "Passw0rd!", displayName: "Platform Root Account" },
  /** An administrator entitled to two areas. The ordinary case. */
  administrator: { username: "admin.branch", password: "Passw0rd!" },
  /** FA-01.4: authenticates perfectly well and is entitled to nothing. */
  none: { username: "admin.none", password: "Passw0rd!" },
} as const;

export const REFERENCE_AREA = "Branch Network";
export const READ_ONLY_SCRIPT = "inventory-report.sh";
export const MODIFYING_SCRIPT = "site-rollout.sh";
