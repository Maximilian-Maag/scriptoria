import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hostPatterns, isKnownHostKey, parseKnownHosts } from "../src/ssh/knownHosts";

const KEY = Buffer.from("a-public-key-blob");
const OTHER = Buffer.from("a-different-key-blob");
const encoded = KEY.toString("base64");

describe("parseKnownHosts", () => {
  it("reads a plain entry", () => {
    const [entry] = parseKnownHosts(`script-vm ssh-ed25519 ${encoded} comment\n`);
    expect(entry?.hosts).toEqual(["script-vm"]);
    expect(entry?.key).toBe(encoded);
  });

  it("skips comments and blank lines", () => {
    expect(parseKnownHosts("# nothing here\n\n   \n")).toHaveLength(0);
  });

  it("skips certificate authority and revocation markers", () => {
    // Accepting a CA here would be trust on first use with extra steps, which
    // is the thing ADR-001 pins host keys to avoid.
    expect(parseKnownHosts(`@cert-authority * ssh-ed25519 ${encoded}\n`)).toHaveLength(0);
  });
});

describe("isKnownHostKey", () => {
  it("accepts the pinned key for the pinned host", () => {
    const entries = parseKnownHosts(`script-vm ssh-ed25519 ${encoded}\n`);
    expect(isKnownHostKey(entries, "script-vm", 22, KEY)).toBe(true);
  });

  it("rejects a different key for a host it knows", () => {
    const entries = parseKnownHosts(`script-vm ssh-ed25519 ${encoded}\n`);
    expect(isKnownHostKey(entries, "script-vm", 22, OTHER)).toBe(false);
  });

  it("rejects the right key for a host it does not know", () => {
    const entries = parseKnownHosts(`script-vm ssh-ed25519 ${encoded}\n`);
    expect(isKnownHostKey(entries, "somewhere-else", 22, KEY)).toBe(false);
  });

  it("matches the bracketed form when the port is not 22", () => {
    const entries = parseKnownHosts(`[localhost]:2222 ssh-ed25519 ${encoded}\n`);
    expect(isKnownHostKey(entries, "localhost", 2222, KEY)).toBe(true);
    // A key pinned for one port says nothing about another.
    expect(isKnownHostKey(entries, "localhost", 22, KEY)).toBe(false);
  });

  it("matches a hashed entry", () => {
    const salt = randomBytes(20);
    const digest = createHmac("sha1", salt).update("script-vm").digest();
    const line = `|1|${salt.toString("base64")}|${digest.toString("base64")} ssh-ed25519 ${encoded}`;

    expect(isKnownHostKey(parseKnownHosts(line), "script-vm", 22, KEY)).toBe(true);
    expect(isKnownHostKey(parseKnownHosts(line), "other-vm", 22, KEY)).toBe(false);
  });

  it("rejects everything when the file is empty", () => {
    // The failure mode that matters: no pins must mean no connections, not all
    // of them.
    expect(isKnownHostKey([], "script-vm", 22, KEY)).toBe(false);
  });
});

describe("hostPatterns", () => {
  it("writes port 22 both ways and any other port one way", () => {
    expect(hostPatterns("vm", 22)).toEqual(["vm", "[vm]:22"]);
    expect(hostPatterns("vm", 2222)).toEqual(["[vm]:2222"]);
  });
});
