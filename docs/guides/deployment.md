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

## Creating the machines

`infra/terraform` makes the machines exist. Five implementations — Linode, AWS, GCP, Azure, STACKIT
— behind one interface, because the runtime above them is the same everywhere: Linux, systemd,
rootless podman, nginx. The provider only decides how machines are created and how reachability is
expressed, and everything below applies identically whoever it was.

```sh
cd infra/terraform/<provider>
terraform init -backend-config=bucket=... -backend-config=key=<env>.tfstate -reconfigure
terraform apply -var-file=../environments/<env>.tfvars -var-file=~/scriptoria-<env>.tfvars
```

`<env>.tfvars` is the shape — which roles, how many, how big (`dev` is three machines, `staging` and
`prod` are five). The operator's own file carries the two things the repository deliberately does not:
their SSH public key, and who may reach SSH. The apply prints `instances`, every machine by role with
the address another machine in the environment reaches it on, and `public_address`, which is what the
environment's DNS record points at.

Point DNS at it, then prepare each host as above — with those addresses the answer to "what goes in
`app.env`" stops being a question. [The hosts](../../infra/terraform/README.md) has the contract, the
per-provider differences and what an apply cannot be trusted to have proved.

No provider is named anywhere in the platform. That is a decision rather than a preference: naming
one would put it in the architecture model, the README and every runbook, and the first environment
that had to be built somewhere else would arrive as a rewrite.

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
| `/etc/scriptoria/scriptoria-<unit>.env` | Per-instance values, and in practice two: `HOST_PORT`, the port a control-plane process is published on — required, not optional, for every `scriptoria-backend@N` — and `BIND_ADDRESS`, the address a store or the directory publishes on. |

### The one thing that costs an afternoon

**A container's localhost is not the host.** Where a service is another container on the same
instance, the host in a URL is the *container name*; where it is a different instance — the data
instance, the directory, the script VM — it is that instance's VPC address. `check-env.sh` refuses
`localhost` and `127.0.0.1` in a deployment's configuration for exactly this reason, because the
failure it causes ("connection refused" from a container that is running perfectly) points at the
wrong component.

**And the other half of the same mistake: `BIND_ADDRESS`.** The stores and the directory publish on
`127.0.0.1` by default, which is right when they share a machine with the app — dev — and wrong the
moment they do not: staging's and production's app instance reaches PostgreSQL over the environment's
private network, so the data instance has to publish on the address it was given, not on loopback.
Set `BIND_ADDRESS` in `/etc/scriptoria/scriptoria-postgres.env`, `scriptoria-redis.env` and
`scriptoria-openldap.env` to the machine's address from the apply's `instances` output, and point
`DATABASE_URL`, `REDIS_URL` and `LDAP_URL` in `app.env` at that same address. A store bound to
loopback on its own machine is a store nothing can reach, and the error reads as though the store
were down.

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

A push to `staging` or `main` runs `.github/workflows/release.yml`, which builds all three images
and — where a registry is configured — publishes `scriptoria-backend` and `scriptoria-runner` tagged
with the branch and the commit. The registry is a repository variable plus two secrets, not a
constant (see the branch guide); unset, that job builds and publishes nothing. The **frontend is
never published**: its terminal address is compiled in at build time, so it is built per
environment, here:

    # on the build machine: build, then one tarball — with *this environment's* terminal address,
    # because the frontend bundle has it compiled in and no runtime setting can change it
    make deploy-images TERMINAL_WS_URL=wss://<this environment's host>
    infra/deploy/scripts/load-images.sh scriptoria-images.tar    # on each host

Passing `TERMINAL_WS_URL` is not optional in anything but the dev default: `make deploy-images`
builds the frontend with `NEXT_PUBLIC_TERMINAL_WS_URL` as a **build argument**, and the Dockerfile
compiles it into the bundle. Build without it and the tarball's frontend is an image whose terminal
sockets go to `ws://localhost:3001` — which a browser on that host will fail to reach, and which no
restart repairs, because the address is in the JavaScript.

Give the **host, without a path**: the client appends `/terminal` itself
(`useTerminalStream.ts` opens `${WS_BASE}/terminal`), so an address that already ends in `/terminal`
becomes `…/terminal/terminal` and the socket never opens.

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

`install.sh` enables the timer on every host, because a backup that depends on somebody remembering
to switch it on is a backup that does not exist. The unit then skips itself where there is no store
container, so an app or runner instance runs no backup and reports no failure — and the timer being
enabled everywhere is why nothing else has to know which machine is the data instance.

    sudo systemctl start scriptoria-backup.service     # by hand, e.g. before a schema change
    systemctl list-timers scriptoria-backup.timer      # when the next one is due

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

Run against a database the end-to-end suite had filled rather than a freshly migrated one — 117
runs, 907 events, 116 transcripts, 249 result files, 875 audit entries — the command above gave
`pg_restore` **exit 0, no errors, no warnings**, and every table's contents were identical by md5.
A restore that works is silent; the seconds between stopping the control plane and starting it
again are the only thing to watch.

**Keep the client's major version equal to the server's.** The restore image and the one
`scriptoria-backup.service` dumps with are both `postgres:16-alpine`, and that is a requirement
rather than a habit: `pg_dump` from a *newer* client writes `SET transaction_timeout = 0;`, which is
a PostgreSQL 17 setting, and a 16 server rejects it. `pg_restore` then answers

    pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"
    pg_restore: warning: errors ignored on restore: 1

and exits **1** — on a restore that otherwise completed. Upgrade the image, the dump and the restore
together, or not at all.

## What is checked, and where

`make deploy-check` runs five things, and CI runs them on every pull request in the "Deployment
configuration" job:

- the scripts parse;
- `app.env.example` satisfies the deployment's rules, and the rules refuse what they claim to;
- every unit passes `systemd-analyze verify` (a missing `podman` binary is a fact about the machine
  running the check, not about the unit, and is filtered);
- `nginx -t` accepts the proxy configuration — the same parser the proxy itself runs;
- each of the five Terraform implementations validates against its provider's real schema, the five
  still declare the same contract, and the cloud-init document renders with every file of this
  deployment layer in it.

None of it proves an environment comes up. It cannot: the first four are checks on files, and the
fifth is as far as Terraform can go without an account — a machine type that does not exist in a
region, a quota, a missing permission or a wrong subnet would be found by an apply and by nothing
here.
