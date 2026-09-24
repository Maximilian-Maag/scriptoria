import { describe, expect, it } from "vitest";
import { escapeDnValue, escapeFilterValue } from "../src/lib/auth/directory";

/**
 * The two operations the platform performs against the directory (FA-01.2,
 * NFR-02), and the one thing they have in common: **a username is user input,
 * and it goes into a search filter and into a distinguished name**.
 *
 * Both are small, pure and easy to look at — which is exactly why nothing had
 * checked them. A value is interpolated into
 *
 *     (member=<dn>)                        ← the filter  (RFC 4515)
 *     cn=<username>,ou=users,…             ← the DN      (RFC 4514)
 *
 * and the whole point of escaping is that the *shape* of those strings is not
 * decided by whoever typed the username. `admin*)(objectClass=*` must be a
 * literal, not an early end to an atom; `admin,ou=admins` must be one RDN, not
 * two. Neither failure needs a directory to be running to be provable: escaping
 * is a string transformation, and this file asserts on the string.
 *
 * The round-trip properties at the end are the ones worth keeping. Escaping
 * that cannot be undone is not escaping — it is a mangled name, and the login
 * it belongs to fails for a reason nobody will guess from the outside.
 */

describe("escapeFilterValue (RFC 4515)", () => {
  it("escapes the characters that end a filter atom", () => {
    // The five the RFC names. `*` first because it is the injection primitive:
    // an unescaped one turns an equality match into a wildcard match.
    expect(escapeFilterValue("*")).toBe("\\2a");
    expect(escapeFilterValue("(")).toBe("\\28");
    expect(escapeFilterValue(")")).toBe("\\29");
    expect(escapeFilterValue("\\")).toBe("\\5c");
    expect(escapeFilterValue("\0")).toBe("\\00");
  });

  it("leaves an ordinary value alone", () => {
    expect(escapeFilterValue("cn=Jane Doe,ou=users")).toBe("cn=Jane Doe,ou=users");
    expect(escapeFilterValue("")).toBe("");
  });

  it("escapes a backslash once, rather than escaping what it escapes", () => {
    // The trap in any character-wise escaping: replacing `\` first and then
    // scanning again turns `\2a` into `\5c2a`, and the value that survives is
    // two characters where the user typed one.
    expect(escapeFilterValue("\\2a")).toBe("\\5c2a");
    expect(escapeFilterValue("a\\*b")).toBe("a\\5c\\2ab");
  });

  it("cannot let a username end the atom it is put in", () => {
    // The hostile value an operator would try. Whatever survives of it, the
    // filter the platform builds afterwards still has the shape the template
    // wrote: the parens and the wildcards are gone as syntax.
    const hostile = "*)(objectClass=*))(|(cn=*";
    const escaped = escapeFilterValue(hostile);

    expect(escaped).not.toMatch(/[()*]/);
    expect(escaped).not.toContain("\0");

    // The composed filter, spelled the way `resolveGroups` composes it. The
    // template's own parentheses are the only ones in the result: the value
    // contributes none of its own.
    const filter = `(&(objectClass=group)(member=${escaped}))`;
    expect(filter.match(/\(/g)).toHaveLength(3);
    expect(filter.match(/\)/g)).toHaveLength(3);
    expect(filter.endsWith("))")).toBe(true);
  });
});

describe("escapeDnValue (RFC 4514)", () => {
  /** Undoes one level of escaping, the way a directory reading a DN would. */
  const unescapeDnValue = (value: string): string => value.replace(/\\(.)/g, "$1");

  it("escapes the characters that structure a distinguished name", () => {
    expect(escapeDnValue("a,b")).toBe("a\\,b");
    expect(escapeDnValue("a+b")).toBe("a\\+b");
    expect(escapeDnValue('a"b')).toBe('a\\"b');
    expect(escapeDnValue("a<b>c")).toBe("a\\<b\\>c");
    expect(escapeDnValue("a;b")).toBe("a\\;b");
    expect(escapeDnValue("a=b")).toBe("a\\=b");
    expect(escapeDnValue("a\\b")).toBe("a\\\\b");
  });

  it("escapes the characters the RFC reserves at the ends only", () => {
    expect(escapeDnValue("#hash")).toBe("\\#hash");
    expect(escapeDnValue(" lead")).toBe("\\ lead");
    expect(escapeDnValue("trail ")).toBe("trail\\ ");
    // A space in the middle is an ordinary character and stays one.
    expect(escapeDnValue("Jane Doe")).toBe("Jane Doe");
  });

  it("leaves a value that needs nothing alone", () => {
    expect(escapeDnValue("")).toBe("");
    expect(escapeDnValue("jdoe")).toBe("jdoe");
  });

  it("keeps a username one RDN, however many commas it contains", () => {
    // The DN an operator would try to extend. Every comma the username carries
    // is escaped, so the template's own separators are still the only ones.
    const hostile = "admin,ou=admins,dc=scriptoria,dc=test";
    const escaped = escapeDnValue(hostile);

    expect(escaped).not.toMatch(/[^\\],/);
    expect(`cn=${escaped},ou=users,dc=scriptoria,dc=test`.match(/[^\\],/g)).toHaveLength(3);
  });

  it("round-trips every value it is given", () => {
    // The property, not the examples: escaping is only escaping if a directory
    // reads the original value back out of it.
    const values = [
      "",
      "jdoe",
      "Jane Doe",
      "a,b",
      " lead",
      "trail ",
      " lead and trail ",
      "#hash",
      "a\\b",
      "\\",
      " ",
      "  ",
      "\\ ",
    ];

    for (const value of values) {
      expect(unescapeDnValue(escapeDnValue(value)), `round trip for ${JSON.stringify(value)}`).toBe(
        value,
      );
    }
  });
});
