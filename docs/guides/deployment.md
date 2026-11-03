# Deploying Scriptoria

A provisioned environment is one private network with a reverse proxy holding the only public
address (NFR-01). This is what has to be true on each host before that works, in what order, and
what a release does.

`infra/deploy` holds the pieces: the proxy's configuration, the systemd units, the one
configuration file an operator fills in, and the scripts that check all of it. The hosts
themselves are provisioned by Terraform, which is the next piece of this milestone and not here
yet — until it exists, `infra/deploy/scripts/install.sh` is run on a host that was made some
other way, and that is the part still missing.

    make deploy-check        # everything below that can be checked without a host

## What runs where

The environment's shape is [in the model](../architecture/workspace.dsl), and the process counts
differ by environment. In short:

| Environment | Instances | Control plane | Runner | Notes |
|---|---|---|---|---|
| Dev | 3 | 1 process | 1 process | Proxy, frontend, control plane, the stores and the directory are together on one instance. The runner is still separate, so dev is not the one environment where that boundary does not exist. |
| Staging | 5 | 2 processes | 2 processes | Production's shape at the same module versions. |
| Production | 5 | 3 processes | 2 processes | `app`, `runner`, `data` (backed up), `script`, `directory`. |
| Local | — | one stack | one process | `docker-compose`, and never Terraform. |

The **runner** is on its own instance in every environment, because it is the only process holding
SSH keys and the only thing that reaches the script VM. The **frontend** is not separated from the
control plane: it renders and forwards, holds no credentials of its own, and splitting it inside
the same VPC behind the same proxy would buy a boundary nothing enforces while putting a cross-host
hop on every call the API proxy makes.

## One host, before anything

    sudo infra/deploy/scripts/install.sh

It creates the unprivileged `scriptoria` user the containers run as, enables lingering for it,
makes the directories, installs the units and the proxy configuration, and creates the podman
network the containers share. It writes no secrets. The one line in it that is easy to miss and
worth knowing about is `loginctl enable-linger`: rootless podman from a *system* unit needs the
user's runtime directory to exist at boot, and without lingering it exists only while somebody is
logged in — which on a server is never.

Then, per host, all of it an operator's to place:

| Path | What |
|---|---|
| `/etc/scriptoria/app.env` | The deployment's configuration. From `infra/deploy/app.env.example`, 0600 root. |
| `/etc/scriptoria/tls/` | `fullchain.pem` and `privkey.pem` for the public name. The organisation's own CA — NFR-01's network has no route out to a public one. |
| `/etc/scriptoria/ssh/` | The script VM's key (`id_ed25519`) and its `known_hosts`. Runner instances only. |
| `/etc/scriptoria/ldifs/` | The directory's LDIFs. Directory instances only, and the organisation's own — the fixture in `infra/openldap/ldifs` is four invented accounts for a development machine. |
| `/etc/scriptoria/scriptoria-<unit>.env` | Per-instance values, and in practice one: the port a control-plane process is published on. |

### The one thing that costs an afternoon

**A container's localhost is not the host.** Where a service is another container on the same
instance, the host in a URL is the *container name*; where it is a different instance — the data
instance, the directory, the script VM — it is that instance's VPC address. `check-env.sh` refuses
`localhost` and `127.0.0.1` in a deployment's configuration for exactly this reason, because the
failure it causes ("connection refused" from a container that is running perfectly) points at the
wrong component.

### The configuration is one file, and it is checked

`app.env` holds the applications' settings and the bootstrap variables the data containers read,
together, because they describe one deployment. That is also what makes them checkable:

    infra/deploy/scripts/check-env.sh /etc/scriptoria/app.env

It refuses a `POSTGRES_PASSWORD` that disagrees with `DATABASE_URL`, a directory whose root is not
the platform's base DN, `ldap://` instead of `ldaps://` (NFR-02), a session cookie without `Secure`,
a deployment that is not behind a trusted proxy, host key verification switched off, and a value
still left as `CHANGEME`. Every one of those is otherwise met as something else — "password
authentication failed" at first login, or a group membership that is whatever a machine in the
middle says it is. `check-env.test.sh` mutates the example sixteen ways and asserts each is
refused, so the checker is checked too.

## First bring-up

Images first — see [Releases](#a-release) — then, on the **data and directory** instances:

    sudo systemctl enable --now scriptoria-postgres scriptoria-redis scriptoria-openldap

On the **app** instance, in this order, because each step is what the next one needs:

    sudo systemctl start scriptoria-migrate.service   # apply the schema; read its output
    sudo systemctl enable --now scriptoria-backend@1 scriptoria-frontend nginx

Then, once, to create the root group mapping and the reference area:

    sudo -u scriptoria podman run --rm --network=scriptoria \
      --env-file=/etc/scriptoria/app.env --workdir /app/packages/db \
      scriptoria-backend:latest node --import tsx src/seed.ts

And on each **runner** instance:

    sudo systemctl enable --now 'scriptoria-runner@1'        # add @2 where the environment has two

The proxy is the only thing with a public address, and it terminates TLS, routes the terminal
WebSocket straight to the control plane, and publishes the control plane's health endpoint as
`/healthz` for the external monitor (NFR-16). The control plane's own `/api/*` is deliberately not
published: the browser's REST surface is the frontend, which is what keeps session material out of
browser JavaScript.

## A release

    make deploy-images                    # on the build machine: build, then one tarball
    infra/deploy/scripts/load-images.sh scriptoria-images.tar    # on each host

The tarball carries the three platform images and the three the data and directory instances run.
Nothing is pulled on a provisioned host: NFR-01 puts these networks in a position where there is no
registry to reach, and every unit says `--pull=never` so a missing image fails immediately rather
than spending a timeout on one.

Then, on the app instance:

    sudo systemctl restart scriptoria-migrate.service    # schema first, and read its output
    sudo systemctl restart 'scriptoria-backend@1'        # one at a time, in production
    sudo systemctl restart scriptoria-frontend

Restarting a control plane does **not** stop a running script: the PTY lives in the runner, which
is why the runner is a separate process and a separate instance. The runner is restarted
deliberately and separately, and its stop timeout is two minutes because stopping it means letting
its runs wind up (ADR-003).

Rolling back is loading the previous tarball and restarting the same way. The schema is the one
thing a rollback cannot undo on its own — migrations are forward-only — which is what the backup
before a schema change is for.

## Backup and restore

`scriptoria-backup.timer` takes a daily `pg_dump` into `/var/lib/scriptoria/backups` on the data
instance, verifies the archive lists, and keeps a fortnight. The unit fails if the dump cannot be
read back, because a dump nobody has looked at is a file rather than a backup.

    sudo systemctl start scriptoria-backup.service     # by hand, e.g. before a schema change

The dump does **not** leave the host. That is deliberate: NFR-01 puts the environment in a network
with no route out, so there is nowhere for a timer to push it, and moving it is an operator's job
with the tools they already have. It is the only part of this that cannot be automated from inside.

    # restore, into a running PostgreSQL:
    sudo systemctl stop 'scriptoria-backend@*' scriptoria-frontend
    sudo -u scriptoria podman run --rm --network=scriptoria \
      --env-file=/etc/scriptoria/app.env \
      --volume /var/lib/scriptoria/backups:/backups:ro \
      --entrypoint /bin/sh postgres:16-alpine -c \
      'pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" /backups/<file>.dump'
    sudo systemctl start 'scriptoria-backend@1' scriptoria-frontend

## What is checked, and where

`make deploy-check` runs four things, and CI runs them on every pull request in the "Deployment
configuration" job:

- the scripts parse;
- `app.env.example` satisfies the deployment's rules, and the rules refuse what they claim to;
- every unit passes `systemd-analyze verify` (a missing `podman` binary is a fact about the machine
  running the check, not about the unit, and is filtered);
- `nginx -t` accepts the proxy configuration — the same parser the proxy itself runs.

None of it proves an environment comes up. That needs hosts, and hosts need the Terraform modules.
