import { z } from "zod";

/**
 * FA-01. A username and a password, and nothing else. There is no SSO button and
 * there never will be one (NFR-02) — the platform binds against the directory
 * with the caller's own credentials, which is also why it stores no password.
 */
export const loginRequestSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1, "Username is required")
    .max(256)
    // A DN separator in a username is either a paste accident or an injection
    // attempt. Neither should reach the directory.
    .refine((u) => !/[,=+<>#;\\"]/.test(u), { message: "contains invalid characters" }),
  password: z.string().min(1, "Password is required").max(1024),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Two roles, and the split is the product's whole authorisation model.
 *
 * An **administrator** runs scripts on the script VM through the platform.
 * The **root account** manages the platform itself: areas, the script
 * directories mapped onto them, and the group entitlements. Root is not a
 * super-administrator — it configures what administrators can reach, which is a
 * different job rather than a larger one.
 */
export const roleSchema = z.enum(["administrator", "root"]);
export type Role = z.infer<typeof roleSchema>;

/**
 * What the browser is told about the current session.
 *
 * Note what is absent: no permission list, no group inventory, no user id the
 * client could use for anything. `areaIds` is here because the navigation needs
 * to render, not because the client is trusted with it — every route re-checks
 * the session's areas server-side before it touches anything (NFR-03).
 */
export const sessionUserSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  role: roleSchema,
  /**
   * The directory groups this session resolved to, for display in the
   * administration view and for the "you are in no entitled group" empty state.
   * Rebuilt from the directory at every login and never persisted as an
   * inventory (NFR-03, NFR-04).
   */
  groups: z.array(z.string()),
  /** Empty is a valid outcome, not an error (FA-01.4). */
  areaIds: z.array(z.string().uuid()),
  expiresAt: z.string().datetime({ offset: true }),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const loginResponseSchema = z.object({ user: sessionUserSchema });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const sessionResponseSchema = z.object({ user: sessionUserSchema.nullable() });
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
