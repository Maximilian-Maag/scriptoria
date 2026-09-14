import { z } from "zod";
import { remotePathSchema } from "./common";

/**
 * FA-11. An area is one service — a branch network, a firewall estate, a data
 * centre — and it is the unit everything else hangs off: scripts are mapped onto
 * it by filesystem path, and directory groups are entitled onto it.
 *
 * Without this mapping the platform shows nobody anything, which is why FA-11
 * is built immediately after the walking skeleton.
 */

/** FA-11.5. Structures the navigation, nothing more. */
export const areaCategorySchema = z.enum(["one-off", "recurring"]);
export type AreaCategory = z.infer<typeof areaCategorySchema>;

/**
 * Where an area's scripts live: a directory on a script VM.
 *
 * The host is part of the mapping rather than a global setting. Normally every
 * area names the same script VM and differs only in its directory — but NFR-07
 * allows a second one, for example where two sets of scripts need runtimes that
 * cannot coexist, and a global setting would have to be unpicked to allow it.
 */
export const scriptSourceSchema = z.object({
  id: z.string().uuid(),
  /** The script VM the scripts live on. Resolved by the runner, never by the browser. */
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(22),
  /** The account the scripts run as — their service context (FA-05.3). */
  username: z.string().trim().min(1).max(64),
  /** FA-11.2: the filesystem path whose scripts belong to this area. */
  scriptPath: remotePathSchema,
  /** Where the scripts write their results. Date-stamped by the scripts. */
  outputPath: remotePathSchema,
});
export type ScriptSource = z.infer<typeof scriptSourceSchema>;

/**
 * FA-11.3/11.4. A reference to a directory group by name — a *reference*, not a
 * copy. The platform holds no member list and resolves membership from the
 * directory at every login (NFR-03, NFR-04).
 */
export const groupEntitlementSchema = z.object({
  id: z.string().uuid(),
  directoryGroup: z.string().trim().min(1).max(256),
});
export type GroupEntitlement = z.infer<typeof groupEntitlementSchema>;

export const areaSchema = z.object({
  id: z.string().uuid(),
  /** Simplest case: the area name matches the directory group name. */
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(2000).default(""),
  category: areaCategorySchema,
  sources: z.array(scriptSourceSchema),
  entitlements: z.array(groupEntitlementSchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Area = z.infer<typeof areaSchema>;

/** What the navigation needs. The full area is a root concern. */
export const areaSummarySchema = areaSchema.pick({
  id: true,
  name: true,
  description: true,
  category: true,
});
export type AreaSummary = z.infer<typeof areaSummarySchema>;

export const createAreaRequestSchema = z.object({
  name: areaSchema.shape.name,
  description: z.string().trim().max(2000).optional(),
  category: areaCategorySchema,
});
export type CreateAreaRequest = z.infer<typeof createAreaRequestSchema>;

export const updateAreaRequestSchema = createAreaRequestSchema.partial();
export type UpdateAreaRequest = z.infer<typeof updateAreaRequestSchema>;

export const createScriptSourceRequestSchema = scriptSourceSchema.omit({ id: true });
export type CreateScriptSourceRequest = z.infer<typeof createScriptSourceRequestSchema>;

export const createGroupEntitlementRequestSchema = groupEntitlementSchema.omit({ id: true });
export type CreateGroupEntitlementRequest = z.infer<typeof createGroupEntitlementRequestSchema>;
