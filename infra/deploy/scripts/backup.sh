#!/bin/sh
#
# One backup of the platform database, taken from inside a PostgreSQL container
# and written to a directory the deployment mounts. Run by scriptoria-backup.timer
# on the data instance, daily.
#
# It is the *audit trail* that makes this matter: it lives in this database and is
# the one thing in the deployment that cannot be rebuilt from a release (the
# architecture notes say so, and the production environment is the one drawn as
# "backed up"). Everything else here — sessions, streams, the queue — can be lost
# without losing a fact.
#
# The dump does NOT leave the host, and that is deliberate rather than unfinished:
# NFR-01 puts this environment in a network with no route out, so there is nowhere
# for a timer to push it. Moving a backup off the machine is an operator's job with
# the tools they already have, and it is the only part of this that cannot be
# automated from inside.

set -eu

: "${DATABASE_URL:?DATABASE_URL must be set — the same one the platform uses}"

backup_dir="${BACKUP_DIR:-/backups}"
keep="${BACKUP_KEEP:-14}"

mkdir -p "$backup_dir"
target="$backup_dir/scriptoria-$(date -u +%Y%m%dT%H%M%SZ).dump"

# Custom format, so a single table can be pulled out of it and so it is compressed
# by default. No owner: a restore is not a claim about which roles exist.
pg_dump --format=custom --no-owner --file="$target" "$DATABASE_URL"

# A dump nobody has looked at is a file, not a backup. Listing the archive proves
# it is readable now, rather than when somebody needs it.
pg_restore --list "$target" > /dev/null

echo "backup written and readable: $target"

# Keep the newest $keep. `ls -t` is the only ordering this image has, and the
# directory holds nothing else.
count=0
for f in $(ls -1t "$backup_dir"/scriptoria-*.dump 2>/dev/null || true); do
  count=$((count + 1))
  if [ "$count" -gt "$keep" ]; then
    rm -f "$f"
  fi
done
