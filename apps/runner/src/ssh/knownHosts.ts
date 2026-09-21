import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Host key pinning (ADR-001).
 *
 * "Trust on first use in an isolated zone is not trust": the whole reason the
 * script VM is reachable only from inside the VPC is that reaching it means
 * reaching everything the scripts can reach. A client that accepts whatever key
 * answers on port 22 defeats that from the inside, so the runner reads a
 * `known_hosts` file and accepts nothing else.
 *
 * Parsing lives here, away from the connection, because it is the part worth
 * testing: an entry that silently fails to match is a runner that cannot
 * connect, and an entry that matches too eagerly is the failure this exists to
 * prevent.
 *
 * The host field is a *pattern list*, the way OpenSSH reads it, and both halves
 * of that matter:
 *
 *   · `*` and `?` are wildcards. An estate pinned the way an operator pins one
 *     — `source-*.example.com`, or a `ssh-keyscan` of a subnet — has to match
 *     those hosts, or every run against that VM is refused.
 *   · a leading `!` excludes. `!vm1,*.example.com` is the only way a file says
 *     "that estate, except this one", and reading it as a plain match honours
 *     an entry the operator deliberately excluded.
 */

/**
 * One element of a host field. Exactly one of `pattern` and `hashed` is set:
 * OpenSSH writes either the name (possibly with wildcards) or the HMAC of it.
 */
export interface KnownHostPattern {
  /** `!element` — an exclusion, not a pin. */
  negated: boolean;
  /** The pattern as written, or null when this element is hashed. */
  pattern: string | null;
  /** A hashed element's salt and expected digest, or null. */
  hashed: { salt: Buffer; digest: Buffer } | null;
}

export interface KnownHostEntry {
  patterns: KnownHostPattern[];
  keyType: string;
  /** Base64 of the public key blob, exactly as SSH sends it. */
  key: string;
}

/** `host` or `[host]:port` — the second form only when the port is not 22. */
export function hostPatterns(host: string, port: number): string[] {
  return port === 22 ? [host, `[${host}]:22`] : [`[${host}]:${port}`];
}

/**
 * OpenSSH's pattern language: `*`, `?`, and everything else literal. A host
 * field has no character classes, so a `[` is a bracket and the start of
 * nothing.
 */
const GLOB_SPECIAL = /[.+^${}()|[\]\\]/;

function compileGlob(pattern: string): RegExp {
  const escaped = pattern.replace(GLOB_SPECIAL, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function parseKnownHosts(contents: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    // A marker line (@cert-authority, @revoked) is not a pin. Skipping it is
    // right: accepting a CA here would be trust on first use with extra steps.
    if (line.startsWith("@")) continue;

    const [hostField, keyType, key] = line.split(/\s+/);
    if (!hostField || !keyType || !key) continue;

    // Every element carries its own negation and, when hashed, its own salt:
    // that is how OpenSSH writes a hashed pattern list.
    const patterns: KnownHostPattern[] = [];
    for (const element of hostField.split(",")) {
      const negated = element.startsWith("!");
      const body = negated ? element.slice(1) : element;
      if (body === "") continue;

      if (body.startsWith("|1|")) {
        const [, , salt, digest] = body.split("|");
        if (!salt || !digest) continue;
        patterns.push({
          negated,
          pattern: null,
          hashed: { salt: Buffer.from(salt, "base64"), digest: Buffer.from(digest, "base64") },
        });
        continue;
      }

      patterns.push({ negated, pattern: body, hashed: null });
    }

    if (patterns.length === 0) continue;
    entries.push({ patterns, keyType, key });
  }

  return entries;
}

/** OpenSSH's hashed form: HMAC-SHA1 of the name, keyed with the salt. */
function matchesHashed(hashed: { salt: Buffer; digest: Buffer }, name: string): boolean {
  const digest = createHmac("sha1", hashed.salt).update(name).digest();
  return digest.length === hashed.digest.length && timingSafeEqual(digest, hashed.digest);
}

/**
 * Whether one element of a host field names one of the names this connection can
 * legitimately be known by — the host, and its `[host]:port` form.
 */
function elementNamesHost(element: KnownHostPattern, names: readonly string[]): boolean {
  const { hashed, pattern } = element;
  if (hashed) return names.some((name) => matchesHashed(hashed, name));
  if (pattern === null) return false;
  const glob = compileGlob(pattern);
  return names.some((name) => glob.test(name));
}

/**
 * Whether the line names this host: some element matches and no negated one
 * does. The exclusion wins.
 */
function entryNamesHost(entry: KnownHostEntry, names: readonly string[]): boolean {
  let named = false;
  for (const element of entry.patterns) {
    if (!elementNamesHost(element, names)) continue;
    if (element.negated) return false;
    named = true;
  }
  return named;
}

/**
 * Whether this key is the pinned key for this host.
 *
 * The comparison is on the key blob rather than on a fingerprint string,
 * because that is what the server actually presented and what the file actually
 * records — a fingerprint is a rendering of it, and rendering before comparing
 * is where a comparison quietly stops being one.
 */
export function isKnownHostKey(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number,
  key: Buffer,
): boolean {
  const names = hostPatterns(host, port);
  const presented = key.toString("base64");

  return entries.some((entry) => entryNamesHost(entry, names) && entry.key === presented);
}
