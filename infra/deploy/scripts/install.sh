#!/bin/sh
#
# Prepare one host for Scriptoria. Run once, as root, on each instance — the app
# instance, the runner's, the data instance and the directory's. It creates no
# secrets and writes none: the values live in /etc/scriptoria/app.env, which an
# operator fills in from ../app.env.example, and the SSH key and TLS material are
# theirs to place.
#
#   ./install.sh                  # from a checkout on the host
#
# Idempotent: it is safe to re-run after a release to pick up changed units.

set -eu

[ "$(id -u)" -eq 0 ] || {
    echo "install.sh must run as root" >&2
    exit 1
}

here=$(cd "$(dirname "$0")" && pwd)
deploy=$(dirname "$here")
user="${SCRIPTORIA_USER:-scriptoria}"

# ── The unprivileged user the containers run as ───────────────────────────────
# A system account: no password, no interactive shell. `runuser` executes a
# command without consulting the shell, so the podman calls below work regardless.
if ! getent passwd "$user" > /dev/null; then
    useradd --system --create-home --shell /usr/sbin/nologin "$user"
    echo "created user $user"
fi

# Rootless podman runs the containers as this user inside a subordinate id range,
# and `useradd --system` does not allocate one — a human's account gets a range
# from login.defs; a system account does not. Without this, the first `podman run`
# fails with "no subuid ranges for user", which reads as a podman problem rather
# than as an account created by a different rule. Take the first free range.
if ! grep -q "^$user:" /etc/subuid 2> /dev/null || ! grep -q "^$user:" /etc/subgid 2> /dev/null; then
    # The first free range is *after the end of the highest one in either file*, not
    # after the highest range that happens to start on a 65536 boundary: a range with
    # a different count (`alice:100000:100000` occupies up to 199999) overlaps a naive
    # `start += 65536`, and two accounts sharing host uids is the isolation the
    # subordinate range exists to provide.
    # `|| echo 100000` for a host with no shadow subuid files at all: there is nothing
    # to collide with, so the first range is the right answer rather than a failure
    # under `set -e`.
    start=$(awk -F: '
        $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { end = $2 + $3; if (end > max) max = end }
        END { if (max < 100000) max = 100000; print max }
    ' /etc/subuid /etc/subgid 2> /dev/null || echo 100000)
    for file in /etc/subuid /etc/subgid; do
        grep -q "^$user:" "$file" 2> /dev/null || printf '%s:%s:65536\n' "$user" "$start" >> "$file"
    done
    echo "allocated subordinate ids $start-$((start + 65535)) to $user"
fi

# Rootless podman from a *system* unit needs the user's runtime directory to exist
# at boot, and without lingering it exists only while somebody is logged in — which
# on a server is never. This one line is the difference between a stack that comes
# back after a reboot and a stack that does not.
loginctl enable-linger "$user"

# ── Directories ───────────────────────────────────────────────────────────────
for d in postgres redis openldap backups; do
    install -d -o "$user" -g "$user" -m 0750 "/var/lib/scriptoria/$d"
done

# The configuration, readable only by root: systemd reads it as root and hands it
# to the containers through the credential store, so nothing else on the machine
# has a reason to open it.
install -d -m 0700 /etc/scriptoria/ssh
install -d -m 0750 /etc/scriptoria/tls
install -d -m 0750 /etc/scriptoria/ldifs
[ -f /etc/scriptoria/app.env ] || install -m 0600 "$deploy/app.env.example" /etc/scriptoria/app.env

# ── The proxy ─────────────────────────────────────────────────────────────────
install -d -m 0755 /etc/nginx/scriptoria/upstreams
install -m 0644 "$deploy/nginx/nginx.conf" /etc/nginx/nginx.conf
install -m 0644 "$deploy/nginx/upstreams/"*.conf /etc/nginx/scriptoria/upstreams/

# ── The units ─────────────────────────────────────────────────────────────────
install -d -m 0755 /etc/scriptoria
install -m 0755 "$deploy/scripts/backup.sh" /etc/scriptoria/backup.sh
install -m 0644 "$deploy"/systemd/* /etc/systemd/system/
systemctl daemon-reload

# ── The backup timer ──────────────────────────────────────────────────────────
# Enabled here rather than left to the operator, because a backup nobody remembered
# to switch on is a backup that does not exist. It is enabled on every host and the
# unit skips itself where the store is not running (see scriptoria-backup.service),
# so the only thing an operator has to get right is the store being on the data
# instance in the first place.
systemctl enable --now scriptoria-backup.timer > /dev/null
echo "enabled scriptoria-backup.timer"

# ── The network the containers share ──────────────────────────────────────────
# Named rather than the default, so that "which containers can talk to each other"
# is answered by this deployment rather than by podman's defaults.
runuser -u "$user" -- podman network create scriptoria > /dev/null 2>&1 ||
    echo "network scriptoria already exists"

cat <<EOF

The host is prepared. What is left is what only an operator can do:

  1. Fill in /etc/scriptoria/app.env  (see $deploy/app.env.example).
  2. Place the TLS material in /etc/scriptoria/tls/{fullchain.pem,privkey.pem}.
  3. Place the script VM's key and known_hosts in /etc/scriptoria/ssh/.
  4. On the directory instance, place the directory's LDIFs in /etc/scriptoria/ldifs/.
  5. Load the release's images:  $here/load-images.sh <images.tar>
  6. Check the configuration:   $here/check-env.sh /etc/scriptoria/app.env

Then \`systemctl start scriptoria-postgres scriptoria-redis scriptoria-openldap\`
on the data and directory instances, \`systemctl start scriptoria-migrate\` once,
and \`systemctl start scriptoria-backend@1 scriptoria-frontend nginx\` on the app
instance. See docs/guides/deployment.md for the order and for the per-instance
files each environment needs.
EOF
