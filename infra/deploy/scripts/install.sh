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
