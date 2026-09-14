/**
 * What a result file is, as far as the UI is concerned (FA-09.1, FA-09.4).
 *
 * Advisory only. This decides whether the result view offers a preview and a
 * copy button, and nothing else — it never decides whether a file is listed or
 * downloadable. FA-09.5 is explicit that results are shown regardless.
 */

const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  log: "text/plain",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  conf: "text/plain",
  cfg: "text/plain",
  ini: "text/plain",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export function contentTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return DEFAULT_CONTENT_TYPE;
  const extension = fileName.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * The cap exists because a single run can produce hundreds of files: somewhere
 * in a set that size there is one that will lock a browser tab if it is
 * rendered inline.
 */
export const MAX_PREVIEW_BYTES = 262_144;

export function isPreviewable(fileName: string, sizeBytes: number): boolean {
  if (sizeBytes > MAX_PREVIEW_BYTES) return false;
  const type = contentTypeFor(fileName);
  return type.startsWith("text/") || type === "application/json" || type === "application/xml";
}

/**
 * The name a downloaded ZIP gets. Date-stamped like the export directories the
 * scripts write into, so a downloaded set and the set on the VM can be matched
 * up by eye.
 */
export function archiveFileName(scriptFileName: string, startedAt: Date): string {
  const base = scriptFileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]/g, "-");
  const stamp = startedAt.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${base}-${stamp}.zip`;
}
