# A stand-in for the script VM. Deliberately minimal: sshd, a service account, a
# script directory, an output directory and a crontab — the four things the runner
# actually touches.
#
# What it is NOT is a copy of a real script VM. NFR-07 says each service has its
# own incompatible runtime environment; reproducing one here would be reproducing
# the wrong one. This fixture proves the mechanism, not the environment.
FROM debian:12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server python3 python3-venv cron \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd

# Mirrors the service account from the setup script the script owner shared:
# no login shell for interactive use, no home directory of its own.
RUN groupadd -g 5000 svc.scripts \
 && useradd -u 5000 -g 5000 -m -d /home/svc.scripts -s /bin/bash -c "script service account" svc.scripts \
 && mkdir -p /home/svc.scripts/.ssh /opt/scriptoria/scripts /opt/scriptoria/export /opt/scriptoria/input \
 && chown -R svc.scripts:svc.scripts /home/svc.scripts /opt/scriptoria \
 && chmod 700 /home/svc.scripts/.ssh

# Keys only. A password-authenticating fixture teaches the wrong habit.
RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config

# cron runs as a second daemon so the recurring-script path (FA-10, ADR-005) has
# a real crontab to be read out of and written back into.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /var/spool/cron/crontabs \
 && chmod 1730 /var/spool/cron/crontabs

EXPOSE 22
CMD ["/usr/local/bin/entrypoint.sh"]
