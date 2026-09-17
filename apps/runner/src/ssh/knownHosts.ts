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
 */

export interface KnownHostEntry {
  /** Plain patterns as written, or a hashed entry's salt and digest. */
  hosts: string[];
  hashed: { salt: Buffer; digest: Buffer } | null;
  keyType: string;
  /** Base64 of the public key blob, exactly as SSH sends it. */
  key: string;
}

/** `host` or `[host]:port` — the second form only when the port is not 22. */
export function hostPatterns(host: string, port: number): string[] {
  return port === 22 ? [host, `[${host}]:22`] : [`[${host}]:${port}`];
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

    if (hostField.startsWith("|1|")) {
      const [, , salt, digest] = hostField.split("|");
      if (!salt || !digest) continue;
      entries.push({
        hosts: [],
        hashed: { salt: Buffer.from(salt, "base64"), digest: Buffer.from(digest, "base64") },
        keyType,
        key,
      });
      continue;
    }

    entries.push({ hosts: hostField.split(","), hashed: null, keyType, key });
  }

  return entries;
}

/** OpenSSH's hashed form: HMAC-SHA1 of the pattern, keyed with the salt. */
function matchesHashed(entry: KnownHostEntry, pattern: string): boolean {
  if (!entry.hashed) return false;
  const digest = createHmac("sha1", entry.hashed.salt).update(pattern).digest();
  return digest.length === entry.hashed.digest.length && timingSafeEqual(digest, entry.hashed.digest);
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
  const patterns = hostPatterns(host, port);
  const presented = key.toString("base64");

  return entries.some((entry) => {
    const namesThisHost = entry.hashed
      ? patterns.some((pattern) => matchesHashed(entry, pattern))
      : entry.hosts.some((known) => patterns.includes(known));
    return namesThisHost && entry.key === presented;
  });
}
