#!/bin/sh
#
# Check a deployment's configuration before it is used, because every mistake this
# catches is one that otherwise surfaces as something else: a password that does
# not match is "password authentication failed" at first login, a URL pointing at
# localhost is a container that cannot reach anything, a plain-LDAP scheme in a
# deployment is NFR-02 quietly not being met.
#
#   ./check-env.sh                      # the example in this directory
#   ./check-env.sh /etc/scriptoria/app.env
#
# It is part of `make deploy-check`, so the example in the repository is checked
# on every pull request: a documented file that does not satisfy its own rules is
# a file nobody has tried.

set -eu

file="${1:-$(dirname "$0")/../app.env.example}"

fail() {
    printf 'FAIL %s\n' "$1" >&2
    exit 1
}

ok() {
    printf 'pass %s\n' "$1"
}

[ -f "$file" ] || fail "no such file: $file"

# The last assignment wins, which is what systemd's EnvironmentFile does too.
val() {
    sed -n "s/^$1=//p" "$file" | tail -1
}

require() {
    [ -n "$(val "$1")" ] || fail "$1 is not set"
}

# ── The shape of a URL ────────────────────────────────────────────────────────
url_host() {
    printf '%s' "$1" | sed -n 's#^[a-z+]*://\([^@/]*@\)\{0,1\}\([^:/]*\).*#\2#p'
}
url_user() {
    printf '%s' "$1" | sed -n 's#^[a-z+]*://\([^:@/]*\):.*#\1#p'
}
url_pass() {
    printf '%s' "$1" | sed -n 's#^[a-z+]*://[^:@/]*:\([^@]*\)@.*#\1#p'
}
url_db() {
    printf '%s' "$1" | sed -n 's#^[a-z+]*://[^/]*/\([^?]*\).*#\1#p'
}

for key in NODE_ENV DATABASE_URL POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD \
    REDIS_URL LDAP_URL LDAP_BASE_DN LDAP_ROOT LDAP_ADMIN_PASSWORD \
    LDAP_BIND_DN LDAP_BIND_PASSWORD BACKEND_INTERNAL_URL; do
    require "$key"
done
ok "every required key is present"

# ── It is a deployment, not a workstation ─────────────────────────────────────
[ "$(val NODE_ENV)" = "production" ] || fail "NODE_ENV is not production"

for key in DATABASE_URL REDIS_URL LDAP_URL BACKEND_INTERNAL_URL; do
    host=$(url_host "$(val "$key")")
    case "$host" in
        localhost | 127.0.0.1 | ::1)
            fail "$key points at $host — a container's localhost is not the host. Use the container name on this instance, or the other instance's VPC address"
            ;;
        "") fail "$key has no host in it" ;;
    esac
done
ok "no address points at a container's own localhost"

# ── The bootstrap variables and the connection string describe one database ────
[ "$(url_pass "$(val DATABASE_URL)")" = "$(val POSTGRES_PASSWORD)" ] ||
    fail "POSTGRES_PASSWORD does not match the password in DATABASE_URL"
[ "$(url_db "$(val DATABASE_URL)")" = "$(val POSTGRES_DB)" ] ||
    fail "POSTGRES_DB does not match the database in DATABASE_URL"
[ "$(url_user "$(val DATABASE_URL)")" = "$(val POSTGRES_USER)" ] ||
    fail "POSTGRES_USER does not match the user in DATABASE_URL"
ok "the database's bootstrap variables agree with DATABASE_URL"

# ── And one directory ─────────────────────────────────────────────────────────
case "$(val LDAP_URL)" in
    ldaps://*) : ;;
    *) fail "LDAP_URL is not ldaps:// — NFR-02 is LDAPS in a deployment" ;;
esac
[ "$(val LDAP_ROOT)" = "$(val LDAP_BASE_DN)" ] ||
    fail "LDAP_ROOT does not match LDAP_BASE_DN"
[ "$(val LDAP_ADMIN_PASSWORD)" = "$(val LDAP_BIND_PASSWORD)" ] ||
    fail "LDAP_ADMIN_PASSWORD does not match LDAP_BIND_PASSWORD — the directory and the platform would be reading it with different credentials"
ok "the directory's bootstrap variables agree with the platform's"

# ── The settings that are the difference between a deployment and a copy of dev ─
[ "$(val SESSION_COOKIE_SECURE)" = "true" ] || fail "SESSION_COOKIE_SECURE is not true"
[ "$(val TRUSTED_REVERSE_PROXY)" = "true" ] ||
    fail "TRUSTED_REVERSE_PROXY is not true — nothing would record the client address the proxy appended (FA-12.1)"
[ "$(val LDAP_TLS_REJECT_UNAUTHORIZED)" = "true" ] ||
    fail "LDAP_TLS_REJECT_UNAUTHORIZED is not true — the group a user is in would be whatever a machine in the middle says"
[ "$(val SSH_SKIP_HOST_KEY_VERIFICATION)" = "false" ] ||
    fail "SSH_SKIP_HOST_KEY_VERIFICATION is not false — the fixture regenerates its host key, a script VM does not"
ok "the deployment is configured as one"

# ── Nothing left to fill in ───────────────────────────────────────────────────
# The example is allowed to carry placeholders; a real file is not.
case "$file" in
    *.example) : ;;
    *)
        if grep -q 'CHANGEME' "$file"; then
            fail "a value is still CHANGEME — this file has not been filled in"
        fi
        ;;
esac
ok "no placeholder is left unset"

printf '\n%s: %s\n' "$file" "ok"
