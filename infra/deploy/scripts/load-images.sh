#!/bin/sh
#
# Load the release's images on a host.
#
# The deployment carries its images rather than pulling them. NFR-01 puts every
# provisioned environment in a network with no route out, so there is no registry
# to pull from and no point at which a deploy could depend on one; the units say
# `--pull=never` for the same reason, so a missing image fails immediately instead
# of spending a timeout on a registry that is not reachable.
#
#   make deploy-images TERMINAL_WS_URL=wss://<this environment's host>
#                               # on the build machine: build, then save to a tarball
#   ./load-images.sh scriptoria-images.tar
#
# The tarball must be readable by the account the containers run as (scriptoria, or
# $SCRIPTORIA_USER): the load is unprivileged, so a tarball left in /root loads
# nothing. The script checks that first and says so.
#
# That build argument is not optional. The frontend compiles the terminal's WebSocket
# address into its bundle (ADR-007), so a tarball built without it ships a frontend whose
# terminal sockets go to `ws://localhost:3001` — and no restart, env file or unit
# override on the host can repair it, because the address is in the JavaScript.
#
# The host WITHOUT a path: the client appends `/terminal` itself, so an address ending in
# `/terminal` becomes `.../terminal/terminal` and the socket never opens.
#
# Loading is additive: it replaces an image of the same tag and leaves the ones it
# does not mention. Rolling back is loading the previous tarball.

set -eu

tarball="${1:-}"
if [ -z "$tarball" ]; then
    echo "usage: $(basename "$0") <images.tar>" >&2
    exit 2
fi
[ -f "$tarball" ] || {
    echo "no such file: $tarball" >&2
    exit 1
}

user="${SCRIPTORIA_USER:-scriptoria}"

# Checked as that account, before anything is loaded, because this is the failure
# that costs the most time: a tarball copied in as root (to /root, 0600) loads
# nothing, and podman's own message for it names a path the operator just proved
# exists. Reading it as `$user` is the same test the load will make.
if ! runuser -u "$user" -- test -r "$tarball"; then
    echo "the tarball must be readable by '$user': it is loaded as that account, not as root" >&2
    echo "  move it, or: install -m 0644 -o $user '$tarball' /var/tmp/$(basename "$tarball")" >&2
    exit 1
fi

# The load itself is unprivileged, and has to be: the images end up in the store of
# the user whose containers will run them, and an image loaded as root would simply
# not be there. `runuser` executes the command directly and does not consult the
# account's shell, which is a nologin one.
runuser -u "$user" -- podman load --input "$tarball"

echo
echo "images now loaded:"
runuser -u "$user" -- podman images --format '  {{.Repository}}:{{.Tag}}  ({{.Size}})'

cat <<'EOF'

A running service keeps the image it was started from. To move a host onto what
was just loaded:

  systemctl restart scriptoria-migrate.service   # schema first, and read its output
  systemctl restart 'scriptoria-backend@*'
  systemctl restart scriptoria-frontend

One at a time on the control plane: they share the proxy's upstream, so restarting
both together is a short outage rather than a rolling one. The runner is restarted
separately and deliberately — a restart there ends the runs it is holding, which is
what its own stop timeout of two minutes is for.
EOF
