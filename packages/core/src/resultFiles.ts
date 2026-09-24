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
 * A file name reduced to the character set a response header and a ZIP entry
 * are both unambiguously safe in: ASCII letters, digits, dot, underscore and
 * hyphen, everything else a hyphen.
 *
 * FA-09.2 / FA-09.3. A result file name is whatever SFTP reported from the
 * script VM, and `fileNameSchema` forbids `/`, `.` and `..` and nothing else —
 * a newline is a legal file name there. A newline makes a header value invalid
 * and `Headers` **throws** on one rather than rendering it, so without this a
 * single planted name turns its download, and the run's whole ZIP, into a 500.
 * Anything outside Latin-1 throws the same way. One rule, applied wherever a
 * name reaches a header or an archive, so a name and its archive entry agree.
 */
export function sanitiseFileName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * The same treatment for a path *inside* an archive. A ZIP entry is a path, not
 * a name, so the separators are kept and each segment is sanitised by the one
 * rule above — collapsing the slashes would flatten a result set's directories
 * into a single level.
 */
export function sanitiseArchiveEntry(path: string): string {
  return path.split("/").map(sanitiseFileName).join("/");
}

/**
 * The name a downloaded ZIP gets. Date-stamped like the export directories the
 * scripts write into, so a downloaded set and the set on the VM can be matched
 * up by eye.
 *
 * The base goes through the sanitiser for the same reason a file name does: the
 * name comes from the script VM and becomes a response header. The fallback is
 * for a script name that leaves nothing behind once its extension is dropped
 * (`.sh`), which would otherwise name the file after the stamp alone.
 */
export function archiveFileName(scriptFileName: string, startedAt: Date): string {
  const base = sanitiseFileName(scriptFileName.replace(/\.[^.]+$/, "")) || "results";
  const stamp = startedAt.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${base}-${stamp}.zip`;
}
