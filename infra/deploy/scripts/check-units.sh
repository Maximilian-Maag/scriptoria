#!/bin/sh
#
# The unit files, checked for what systemd will not tell you.
#
# `systemd-analyze verify` says a unit parses. It does not say that a credential the unit
# names exists, that a variable in it expands, or that a container ends up listening where
# the proxy believes it does. All three of those were found by reading these units *after*
# every check the deployment layer had was green, which is the argument for this file:
#
#   * `LoadCredential=app:/etc/scriptoria/app.env` makes the file available as
#     $CREDENTIALS_DIRECTORY/app — so `--env-file=%d/app.env` is a path that does not
#     exist, and every container in the deployment would have failed to start;
#   * systemd expands `${VAR}` and leaves `${VAR:-default}` alone, so the literal string
#     reaches podman and `--publish 127.0.0.1:${HOST_PORT:-3001}:3001` publishes a *random*
#     port that the proxy's upstream file knows nothing about;
#   * a variable with neither a default nor a required EnvironmentFile expands to nothing
#     at the worst possible moment.
#
#   ./check-units.sh [directory]

set -eu

here=$(cd "$(dirname "$0")" && pwd)
units=${1:-$here/../systemd}

failures=0

fail() {
    echo "units: $1" >&2
    failures=$((failures + 1))
}

for unit in "$units"/*.service "$units"/*.timer; do
    name=$(basename "$unit")

    # Comments are prose, not configuration — the units explain these very traps in
    # comments, and a checker that read them would fail on its own documentation.
    body=$(grep -v '^[[:space:]]*#' "$unit" || true)

    # 1. Every credential a unit refers to has to be one it loads.
    for path in $(printf '%s\n' "$body" | grep -o '%d/[A-Za-z0-9._-]*' | sort -u); do
        id=${path#%d/}
        if ! printf '%s\n' "$body" | grep -q "^LoadCredential=$id:"; then
            fail "$name: '$path' names a credential, but no 'LoadCredential=$id:' loads one"
        fi
    done

    # 2. No bash-style defaults: systemd has no such syntax and passes them through.
    if printf '%s\n' "$body" | grep -q '\${[A-Za-z_][A-Za-z0-9_]*:-'; then
        fail "$name: a \${VAR:-default} — systemd does not expand that form, it passes it through"
    fi

    # 3. Every variable a unit expands needs a value from somewhere: its own
    #    Environment=, or an EnvironmentFile the unit insists on. An optional file with no
    #    default is the case that quietly expands to nothing.
    for var in $(printf '%s\n' "$body" | grep -o '\${[A-Za-z_][A-Za-z0-9_]*}' | tr -d '${}' | sort -u); do
        if printf '%s\n' "$body" | grep -q "^Environment=$var="; then
            continue
        fi
        if ! grep -q '^EnvironmentFile=[^-]' "$unit"; then
            fail "$name: '\${$var}' has no Environment=$var= default and no required EnvironmentFile"
        fi
    done
done

if [ "$failures" -ne 0 ]; then
    exit 1
fi

echo "  every unit's credentials, defaults and variables hold"
