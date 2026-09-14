#!/bin/sh
# Two daemons, because the fixture stands in for the script VM and the script VM
# has both: sshd for the runner, cron for the recurring scripts (FA-10).
set -eu

# Both files are bind-mounted read-only so the source of truth stays in the repo,
# and both are installed on boot rather than used where they are mounted. The
# reason is the same for each: a bind mount carries the host user's ownership,
# and sshd's StrictModes and cron both refuse a file the account does not own.
# Without this, key authentication fails with nothing but "Permission denied
# (publickey)" — which sends you looking at the key, not at the file mode.
if [ -f /opt/scriptoria/authorized_keys ]; then
  install -d -o svc.scripts -g svc.scripts -m 700 /home/svc.scripts/.ssh
  install -o svc.scripts -g svc.scripts -m 600 \
    /opt/scriptoria/authorized_keys /home/svc.scripts/.ssh/authorized_keys
fi

# A schedule written by the platform during a session lives until the container
# restarts — which is what you want from a fixture.
if [ -f /opt/scriptoria/crontab ]; then
  install -o svc.scripts -g svc.scripts -m 600 \
    /opt/scriptoria/crontab /var/spool/cron/crontabs/svc.scripts
fi

cron
exec /usr/sbin/sshd -D -e
