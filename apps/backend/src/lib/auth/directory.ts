import { Client, InvalidCredentialsError } from "ldapts";
import { loadBackendConfig } from "@scriptoria/config";
import { groupNameFromDn } from "@scriptoria/core";
import { err, internal, ok, type Result } from "../result";

/**
 * The directory, and the two operations the platform performs against it.
 *
 * 1. **Authentication is a simple bind with the user's own credentials.** Not a
 *    service-account lookup followed by a password comparison. The consequence
 *    is that the platform stores no user password, needs no password policy of
 *    its own, and inherits lockout and expiry from AD for free (NFR-02).
 *
 * 2. **Group resolution is a read.** It happens after the bind succeeded, with a
 *    read-only service account, and its result is thrown away at the next login
 *    (NFR-03). There is no cache here. A cache would be a group inventory, and
 *    the system is never authoritative for groups.
 */

export interface DirectoryUser {
  username: string;
  dn: string;
  displayName: string;
  /** Group names, already reduced from the DNs AD returns. */
  groups: string[];
}

/** RFC 4515 — a value going into a search filter is escaped, never interpolated. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (char) => {
    switch (char) {
      case "\\":
        return "\\5c";
      case "*":
        return "\\2a";
      case "(":
        return "\\28";
      case ")":
        return "\\29";
      default:
        return "\\00";
    }
  });
}

/** RFC 4514 — the same discipline for a value going into a DN. */
export function escapeDnValue(value: string): string {
  // One pass, with the position-dependent cases anchored inside it. Escaping the
  // leading space in one pass and the trailing space in the next made the second
  // pass see the first pass's backslash and escape that same character twice: a
  // value of a single space came out as `\\ `, which a directory reads back as a
  // backslash followed by a space. Round-tripping is the whole job here — the
  // alternative is a login that fails for a username nobody can retype.
  return value.replace(/[\\,+"<>;=]|^ | $|^#/g, (match) =>
    match === "\\" ? "\\\\" : `\\${match}`,
  );
}

function clientFor(url: string): Client {
  const config = loadBackendConfig();

  // `tlsOptions` is only passed for an ldaps:// URL. ldapts takes its presence
  // as an instruction to open a TLS socket, so passing it alongside a plain
  // ldap:// URL — as the dev fixture uses — makes the client negotiate TLS
  // against a server that is not speaking it, and the bind fails with a socket
  // error that says nothing about the cause.
  const secure = url.toLowerCase().startsWith("ldaps://");

  return new Client({
    url,
    timeout: config.LDAP_TIMEOUT_MS,
    connectTimeout: config.LDAP_TIMEOUT_MS,
    ...(secure
      ? {
          tlsOptions: {
            // Off only against a fixture, where a self-signed chain would be
            // testing the fixture's certificate rather than anything real.
            rejectUnauthorized: config.LDAP_TLS_REJECT_UNAUTHORIZED,
          },
        }
      : {}),
  });
}

/**
 * Puts a value into one of the configured templates.
 *
 * The value is inserted through a callback, because a *replacement string* is
 * not literal: `$&`, `` $` ``, `$'` and `$$` are read as patterns there, and a
 * username may contain any of them. Escaping first does not help — `$` is not a
 * character either RFC 4514 or RFC 4515 asks to escape — so `.replace(place,
 * value)` lets `admin$',ou=admins` end its own RDN and open another one, with
 * the escaping having done its job exactly as written. The callback's return
 * value is used as-is, patterns and all.
 */
export function expandTemplate(template: string, placeholder: string, value: string): string {
  return template.replace(placeholder, () => value);
}

/**
 * Binds as the user, then resolves their groups with the service account.
 *
 * Returns `unauthenticated` for bad credentials and `upstream_unavailable` for a
 * directory that is down — and the distinction matters: the first is the user's
 * problem and the second is not, and telling them apart is the difference
 * between "check your password" and "the domain controller is unreachable".
 */
export async function authenticate(
  username: string,
  password: string,
): Promise<Result<DirectoryUser>> {
  const config = loadBackendConfig();
  const userDn = expandTemplate(
    config.LDAP_USER_DN_TEMPLATE,
    "{username}",
    escapeDnValue(username),
  );

  const userClient = clientFor(config.LDAP_URL);
  try {
    await userClient.bind(userDn, password);
  } catch (cause) {
    if (cause instanceof InvalidCredentialsError) {
      // Deliberately identical for an unknown account and a wrong password. The
      // login form must not become a directory enumeration tool.
      return err("unauthenticated", "Username or password is not correct");
    }
    // Logged here rather than only carried on the Result: this is the failure
    // an operator has to act on, and the user-facing message deliberately says
    // nothing about why.
    console.error("directory bind failed", {
      url: config.LDAP_URL,
      dn: userDn,
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    });
    return err("upstream_unavailable", "The directory is not reachable", { cause });
  } finally {
    await userClient.unbind().catch(() => {});
  }

  const groupsResult = await resolveGroups(userDn);
  if (!groupsResult.ok) return groupsResult;

  return ok({
    username,
    dn: userDn,
    displayName: groupsResult.value.displayName || username,
    groups: groupsResult.value.groups,
  });
}

/**
 * Reads the groups of a DN that has just proved who it is.
 *
 * Searching for `member={userDn}` rather than reading the user's `memberOf`,
 * because `memberOf` is not populated by every directory and the OpenLDAP
 * fixture is one of the ones that does not. Both express the same fact; this one
 * works against both.
 */
async function resolveGroups(
  userDn: string,
): Promise<Result<{ groups: string[]; displayName: string }>> {
  const config = loadBackendConfig();
  const client = clientFor(config.LDAP_URL);

  try {
    await client.bind(config.LDAP_BIND_DN, config.LDAP_BIND_PASSWORD);

    const filter = expandTemplate(config.LDAP_GROUP_FILTER, "{userDn}", escapeFilterValue(userDn));
    const { searchEntries } = await client.search(config.LDAP_GROUP_SEARCH_BASE, {
      filter,
      scope: "sub",
      attributes: ["cn", "distinguishedName"],
    });

    const groups = searchEntries
      .map((entry) => {
        const cn = entry["cn"];
        const name = Array.isArray(cn) ? cn[0] : cn;
        return typeof name === "string" && name !== "" ? name : groupNameFromDn(entry.dn);
      })
      .filter((name): name is string => typeof name === "string" && name !== "");

    let displayName = "";
    const user = await client.search(userDn, {
      scope: "base",
      filter: "(objectClass=*)",
      attributes: ["displayName", "cn"],
    });
    const entry = user.searchEntries[0];
    if (entry) {
      const value = entry["displayName"] ?? entry["cn"];
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string") displayName = first;
    }

    return ok({ groups, displayName });
  } catch (cause) {
    return internal("Could not read the group membership from the directory", cause);
  } finally {
    await client.unbind().catch(() => {});
  }
}
