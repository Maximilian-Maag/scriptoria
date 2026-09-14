import { z } from "zod";
import { remotePathSchema } from "./common";

/**
 * ADR-004. A script declares its own metadata in a header block; the scanner
 * reads the first 100 lines and never the body — real scripts run to thousands
 * of lines and the body is none of the platform's business (FA-03.4).
 */

/**
 * FA-03.5: reading versus modifying, shown *before* the start.
 *
 * `unknown` is a first-class value rather than a null, because ADR-003 treats it
 * as `modifying` and that decision has to be visible in the type rather than
 * buried in a `?? "modifying"` somewhere.
 */
export const criticalitySchema = z.enum(["read-only", "modifying", "unknown"]);
export type Criticality = z.infer<typeof criticalitySchema>;

/** What the header block declared, exactly as parsed. Every key is optional. */
export const scriptHeaderSchema = z.object({
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(4000).optional(),
  criticality: criticalitySchema.optional(),
  interactive: z.boolean().optional(),
  /** Where this script says its results land, if it says so. */
  outputs: remotePathSchema.optional(),
  /**
   * Keys the parser did not recognise, kept rather than dropped. A script owner
   * who adds `scriptoria:owner` should see it somewhere instead of silently losing it.
   */
  extra: z.record(z.string()).default({}),
});
export type ScriptHeader = z.infer<typeof scriptHeaderSchema>;

/**
 * A script as the catalog presents it: the declared header, the admin's
 * overrides, and the effective values the rest of the system acts on.
 */
export const scriptSchema = z.object({
  id: z.string().uuid(),
  areaId: z.string().uuid(),
  sourceId: z.string().uuid(),

  /** The file name in the mapped script directory. Stable identity. */
  fileName: z.string().min(1).max(255),
  absolutePath: remotePathSchema,

  /** Falls back to the file name when the header declares no title. */
  title: z.string(),
  description: z.string(),

  /**
   * What the abort policy and the badge actually use: the admin override if one
   * exists, else the header, else `unknown` — which ADR-003 treats as modifying.
   */
  criticality: criticalitySchema,
  /** True when it was set in the platform rather than declared by the script. */
  criticalityOverridden: z.boolean(),

  interactive: z.boolean(),
  /** Empty when neither the header nor the source mapping says where results go. */
  outputPath: remotePathSchema.nullable(),

  /** Absent when the file carries no readable block — never a reason to hide it. */
  header: scriptHeaderSchema.nullable(),

  sizeBytes: z.number().int().min(0),
  modifiedAt: z.string().datetime({ offset: true }).nullable(),
  /** When the scanner last read this file's header. */
  scannedAt: z.string().datetime({ offset: true }),
});
export type Script = z.infer<typeof scriptSchema>;

/**
 * ADR-004's fallback and override. A wrong declaration is corrected here rather
 * than by editing a production script.
 */
export const setScriptCriticalityRequestSchema = z.object({
  /** `null` clears the override and hands authority back to the header. */
  criticality: criticalitySchema.nullable(),
  reason: z.string().trim().max(500).optional(),
});
export type SetScriptCriticalityRequest = z.infer<typeof setScriptCriticalityRequestSchema>;
