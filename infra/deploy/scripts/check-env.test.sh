#!/bin/sh
#
# The checks in check-env.sh, checked.
#
# Every case below is a way a deployment gets something wrong and finds out as
# something else entirely: a password that does not match is "password
# authentication failed" at first login, a URL pointing at localhost is a
# container that cannot reach anything, `ldap://` in a deployment is NFR-02
# quietly not being met. A checker nobody has watched fail is a checker that might
# be passing everything, so each mutation below has to be refused.
#
# Run by `make deploy-check`, and by CI with it.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
example="$here/../app.env.example"
checker="$here/check-env.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

passed=0
failed=0

# refuses <label> <filename> <sed expression…> — the mutated file must be refused.
refuses() {
    label=$1
    name=$2
    shift 2
    cp "$example" "$tmp/$name"
    sed -i "$@" "$tmp/$name"
    if "$checker" "$tmp/$name" > /dev/null 2>&1; then
        echo "NOT CAUGHT: $label" >&2
        failed=$((failed + 1))
    else
        passed=$((passed + 1))
    fi
}

# ── The example as shipped has to pass ────────────────────────────────────────
# Otherwise the checker is answering a question nobody asked, and every case below
# would be "caught" for the wrong reason.
if "$checker" "$example" > /dev/null 2>&1; then
    passed=$((passed + 1))
else
    echo "WRONGLY REFUSED: the example as shipped" >&2
    failed=$((failed + 1))
fi

refuses "a container-localhost database" probe.env 's#@scriptoria-postgres:#@localhost:#'
refuses "a container-localhost cache" probe.env 's#^REDIS_URL=.*#REDIS_URL=redis://127.0.0.1:6379#'
refuses "a URL with no host at all" probe.env 's#^REDIS_URL=.*#REDIS_URL=redis://#'
refuses "a bootstrap password that disagrees with the URL" probe.env \
    's/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=other/'
refuses "a bootstrap database that disagrees with the URL" probe.env \
    's/^POSTGRES_DB=.*/POSTGRES_DB=elsewhere/'
refuses "a bootstrap user that disagrees with the URL" probe.env \
    's/^POSTGRES_USER=.*/POSTGRES_USER=other/'
refuses "a plain-LDAP directory" probe.env 's#^LDAP_URL=ldaps://#LDAP_URL=ldap://#'
refuses "a directory root that is not the app's base DN" probe.env \
    's/^LDAP_ROOT=.*/LDAP_ROOT=dc=other,dc=org/'
refuses "a bind password that is not the directory's" probe.env \
    's/^LDAP_BIND_PASSWORD=.*/LDAP_BIND_PASSWORD=other/'
refuses "TLS verification against the directory switched off" probe.env \
    's/^LDAP_TLS_REJECT_UNAUTHORIZED=.*/LDAP_TLS_REJECT_UNAUTHORIZED=false/'
refuses "a session cookie without Secure" probe.env \
    's/^SESSION_COOKIE_SECURE=.*/SESSION_COOKIE_SECURE=false/'
refuses "no trusted reverse proxy, so no recorded client address" probe.env \
    's/^TRUSTED_REVERSE_PROXY=.*/TRUSTED_REVERSE_PROXY=false/'
refuses "host key verification against the script VM switched off" probe.env \
    's/^SSH_SKIP_HOST_KEY_VERIFICATION=.*/SSH_SKIP_HOST_KEY_VERIFICATION=true/'
refuses "a development NODE_ENV" probe.env 's/^NODE_ENV=.*/NODE_ENV=development/'
refuses "a required key missing altogether" probe.env '/^REDIS_URL=/d'
# And the one that only applies to a real file: the example is allowed to carry
# placeholders, a deployment is not.
refuses "a value left as CHANGEME" real.env 's/^LDAP_BIND_PASSWORD=.*/LDAP_BIND_PASSWORD=CHANGEME/'

printf 'check-env: %d case(s) held, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
