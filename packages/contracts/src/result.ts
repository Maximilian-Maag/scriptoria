import { z } from "zod";
import { fileNameSchema, remotePathSchema } from "./common";

/**
 * FA-09. A result is a *file written into a defined directory* — not the
 * terminal. The product owner enforced that vocabulary repeatedly and the two
 * are modelled separately because they have different lifecycles.
 *
 * FA-09.5: results are listed for failed and aborted runs too. The exit code
 * ends the run; it does not decide result visibility. A partial result is
 * evidence about what the run managed to do.
 */

export const resultFileSchema = z.object({
  /** Stable within a run — the relative path under the run's output directory. */
  path: z.string().min(1).max(4096),
  name: fileNameSchema,
  sizeBytes: z.number().int().min(0),
  modifiedAt: z.string().datetime({ offset: true }),
  /**
   * Sniffed from the extension on the runner side. Advisory: it decides whether
   * the UI offers a preview (FA-09.1) and nothing else.
   */
  contentType: z.string().max(255),
  /** Whether the result view will try to render it inline rather than only offer a download. */
  previewable: z.boolean(),
});
export type ResultFile = z.infer<typeof resultFileSchema>;

export const resultListSchema = z.object({
  runId: z.string().uuid(),
  /** The directory these were listed from, shown so a user can find them by hand if they must. */
  directory: remotePathSchema,
  files: z.array(resultFileSchema),
  totalBytes: z.number().int().min(0),
  /**
   * True when the run has not finished — the list is what exists so far. A
   * script writing 800 files across 133 sites is not done because five appeared.
   */
  partial: z.boolean(),
  collectedAt: z.string().datetime({ offset: true }),
});
export type ResultList = z.infer<typeof resultListSchema>;

/** FA-09.4: copy, not download. Capped, because a result file can be enormous. */
export const resultPreviewQuerySchema = z.object({
  path: z.string().min(1).max(4096),
  maxBytes: z.coerce.number().int().min(1).max(1_048_576).default(262_144),
});
export type ResultPreviewQuery = z.infer<typeof resultPreviewQuerySchema>;

export const resultPreviewSchema = z.object({
  path: z.string(),
  contentType: z.string(),
  /** Decoded as UTF-8 with replacement; a result preview is not a hex editor. */
  content: z.string(),
  /** True when the file was longer than `maxBytes` and the preview stops early. */
  truncated: z.boolean(),
  sizeBytes: z.number().int().min(0),
});
export type ResultPreview = z.infer<typeof resultPreviewSchema>;

/**
 * FA-09.3. One real run produces roughly 800 files across 133 sites, so the ZIP
 * is the normal case rather than a convenience. An empty `paths` means the whole
 * result set.
 */
export const resultArchiveRequestSchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).max(5000).default([]),
});
export type ResultArchiveRequest = z.infer<typeof resultArchiveRequestSchema>;
