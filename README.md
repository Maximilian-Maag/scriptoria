# Scriptoria

A web frontend through which teams select, start, interactively drive and collect the results
of **existing Linux scripts** that live on a script VM — without Linux, shell or environment
knowledge, and without jump-server handwork.

The platform only *presents* and *starts* scripts. Responsibility for the content and the
effect of a script stays with the script owner — the system context diagram makes this
structural: **there is no edge from Scriptoria to the target systems.** It never reaches a
network device, a firewall or a hypervisor itself. The scripts do, with their own credentials.

## Status

The **walking skeleton is up**: a directory login, the reference area, a script catalog read
off the script VM, a live bidirectional terminal, a staged abort and a result download — the
whole path, end to end, against the dev fixtures. That closes the four risky assumptions build
order §1 names: the LDAP bind, SSH/PTY interactivity, stream latency and SFTP result access.

**Area administration is up** too — build order §2, and the step that stops the platform being
functionless. The root account creates areas, maps script directories onto them and entitles
directory groups (FA-11.1 … FA-11.5), every change is audited (FA-12.2), and a revocation
takes effect on live sessions rather than at the next login: an administrator loses an area
mid-session, without being signed out. That last part is what NFR-03 actually asks for, and
it is why sessions are held server-side instead of in a token.

An area that anything has ever been run in cannot be deleted — a 409, not a cascade. Run
history outranks tidying up the configuration (FA-12.1).

**Build order §3 is closed** — selection and start as two steps (FA-04.1), a start with no
parameters in the script's own service context (FA-05.2, FA-05.3), the dialogue over the PTY
(FA-06), the live terminal and its durable history (FA-07), and the staged abort confirmed by
name for a modifying script (FA-08.3). The run history that makes a finished run findable
again came with it: without it a closed tab lost the run, and with it the results FA-09.5
wants kept visible for a run that *failed*.

What is *not* built yet: the result ZIP (FA-09.3), recurring jobs (FA-10), the audit view and
the OpenAPI document. The first UI draft is deliberately a throwaway iteration and is meant to
be rebuilt once it has been seen (NFR-14). Directories marked *(planned)* below do not exist
yet.

Full requirements: [`docs/requirements/requirements.md`](docs/requirements/requirements.md).
The architecture model: [`docs/architecture/workspace.dsl`](docs/architecture/workspace.dsl).
The decisions behind it: [`docs/architecture/adr/`](docs/architecture/adr/).

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 · React 19 · Tailwind CSS 4 · xterm.js · TanStack Query |
| Backend (control plane) | Next.js 15 · TypeScript · Drizzle ORM · Zod · `ws` on a custom server |
| Runner | Node 22 · ssh2 (SSH, PTY, SFTP) |
| Shared contracts | Zod schemas in `packages/contracts`, used by both sides and by the OpenAPI document |
| Database | PostgreSQL 16 |
| Sessions, streams, job queue | Redis 7 |
| Directory | LDAP / LDAPS (`ldapts`) |
| Package manager | pnpm workspaces |
| Deployment | Terraform per environment — rootless containers under systemd on Linode, behind a reverse proxy with TLS |

Both web tiers are Next.js, as NFR-11 requires; [ADR-002](docs/architecture/adr/002-one-typescript-monorepo.md)
argues that against the obvious split-stack alternative and states what it costs. The terminal
WebSocket lives on a custom Next.js server — [ADR-007](docs/architecture/adr/007-nextjs-custom-server-for-the-terminal.md).

The runner is the one component that is not Next.js: it listens on no port and serves no page,
so there is no web application there for NFR-11 to apply to.

## Architecture

```
Browser ──REST──▶ Frontend (Next.js, API proxy holds the session cookie)
   │                   │
   │                   └──REST──▶ Backend (Next.js, custom server) ──▶ PostgreSQL
   │                                    │                 └──▶ Redis  ── sessions, run streams, job queue
   └──────WSS terminal stream──────────▶│                          ▲
                                        │                          │
                                    Runner Worker ─────────────────┘
                                        │
                                        └──SSH + PTY / SFTP──▶ Script VM  ──▶ Target systems
                                                                                (never the platform)
                                    Backend ──LDAPS──▶ Directory
```

Three things about this shape are not incidental:

- **The runner is a separate process** because a run is a stateful, possibly minutes-long PTY
  session. Inside the web process, every deploy would kill every running script — unacceptable
  for a script that is partway through modifying hundreds of systems.
- **The terminal WebSocket bypasses the frontend** and goes to the backend directly, onto a
  socket its custom server holds open for the life of the run. Every other call goes through
  the frontend's API proxy so no session material reaches browser JavaScript.
- **Terminal and result are two different things** with different lifecycles. The terminal is
  the live byte stream of the process; a result is a file written into a defined directory.
  The architecture keeps that distinction rather than collapsing it.

## Roles

| Role | Description |
|---|---|
| **Administrator** | A directory account in at least one entitled group. Sees the areas released to their groups, runs scripts on the script VM, answers their dialogues, retrieves results. |
| **Root account** | A directory account in a configured root group. Creates areas, maps filesystem paths onto them, entitles directory groups, maintains recurring jobs. |

Root is **not** a bigger administrator. It configures what administrators can reach, which is a
different job: an account entitled to every area still cannot change what the areas are.

There is **no per-account entitlement anywhere in the product**, and no local account or group
inventory. The system is never authoritative for groups: at every login the session's
entitlements are discarded in full and rebuilt from the directory. An account with no matching
group sees an empty screen — a valid outcome, not an error.

The script owner is a role in the domain but not a user of the platform. That is the point.

## Project Structure

```
scriptoria/
├── apps/
│   ├── frontend/               # Next.js 15 UI + API proxy (port 3000)
│   │   └── src/
│   │       ├── app/            # App Router: login, areas, catalog, console, results, admin
│   │       │   └── api/proxy/  # The browser's only REST route to the backend
│   │       └── lib/
│   │           ├── terminal/   # xterm.js mount, binary WebSocket hook, resume-from-id
│   │           └── api/        # Typed client built on packages/contracts
│   ├── backend/                # Next.js 15 API app + terminal WebSocket (port 3001)
│   │   ├── server.ts           # Custom entrypoint: Next.js handler + ws upgrade (ADR-007)
│   │   └── src/
│   │       ├── app/api/        # Thin route handlers: validate → service → toResponse
│   │       └── lib/
│   │           ├── services/   # All domain logic, returns Result<T>
│   │           ├── auth/       # LDAP bind, group resolution, server-side sessions
│   │           ├── runner/     # Asks the runner to read the script VM (queue, not HTTP)
│   │           └── stream/     # Stream gateway: Redis stream ⇄ WebSocket
│   └── runner/                 # SSH/PTY worker — no port, deliberately not Next.js
│       └── src/
│           ├── driver/         # ExecutionTarget interface (ADR-001) and its ssh2 target
│           ├── ssh/            # Key material and host key pinning
│           ├── queue/          # Claims one run per slot off the queue
│           ├── rpc/            # Answers the control plane's reads of the script VM
│           ├── run/            # Run lifecycle, staged abort, transcript, collection
│           └── stream/         # Redis stream publisher, stdin and control subscriber
├── packages/
│   ├── contracts/              # Zod schemas + inferred types, shared by all three apps
│   ├── core/                   # Pure domain logic: authorization, header parsing, cron, exec
│   ├── db/                     # The only package that speaks SQL — schema, repos, migrations
│   └── config/                 # Zod-validated environment loading
├── docs/
│   ├── architecture/
│   │   ├── workspace.dsl       # Structurizr DSL — the architecture source of truth
│   │   ├── adr/                # Architecture decision records
│   │   └── diagrams/           # Generated, gitignored — `make diagrams`
│   └── requirements/
│       └── requirements.md     # FA-xx / NFR-xx, referenced from the model and the code
├── infra/
│   ├── docker-compose.dev.yml  # Postgres, Redis, OpenLDAP, sshd fixture, Structurizr Lite
│   ├── sshd/                   # The stand-in script VM: reference scripts, output dir, crontab
│   ├── openldap/               # Seeded test accounts and groups
│   ├── deploy/                 # (planned) reverse proxy config and systemd units
│   └── terraform/              # (planned) dev, staging and prod from shared modules
├── e2e/                        # (planned) Playwright — the interactive dialogue flow
├── scripts/                    # diagrams.ts, diagramTools.ts — render the C4 model
└── Makefile                    # The entry point for everything — `make help`
```

## Getting Started

```bash
cp .env.example .env    # every value already matches the dev stack
make install            # workspace dependencies
make fixtures-key       # dev SSH keypair for the sshd fixture
make dev                # postgres, redis, openldap, sshd fixture, structurizr
make db-migrate db-seed # schema and the reference area
make run                # frontend :3000, backend :3001, runner
```

`make db-push` exists but currently fails against this schema: drizzle-kit cannot introspect
the expression index on `area_entitlements` (`lower(directory_group)`). `make db-migrate` is
the working path and the one the deployment uses anyway.

On a database whose schema arrived by some route other than `db-migrate`, the migration
journal is empty while the tables already exist, and `make db-migrate` then fails re-creating
the enums. It is a first-run mismatch rather than a schema problem: drop the database volume
(`make dev-down && docker volume rm infra_postgres_data`) and migrate into it clean.

`.env` is worth copying rather than skipping: the schema defaults in `packages/config` are the
production-shaped ones — TLS verification on, `Secure` cookies — and the example file is what
turns them off for plain-http development.

The seeded directory accounts all use the password `Passw0rd!`:

| Account | Groups | What it demonstrates |
|---|---|---|
| `platform.root` | `scriptoria-root` | The root account: administration is reachable |
| `admin.branch` | `scriptoria-branch-network`, `scriptoria-firewall` | An administrator entitled to two areas |
| `admin.datacenter` | `scriptoria-datacenter` | An administrator entitled to one area |
| `admin.none` | — | FA-01.4: authenticates successfully and sees nothing |

The architecture model renders at <http://localhost:8088> once `make dev` is up.

The dev stack includes an **sshd fixture** — a container with a script directory, an output
directory and a crontab — standing in for the script VM, and an **OpenLDAP fixture** standing in
for the directory server. Together they make the entire interactive path testable without
access to the real ones, which is what the e2e suite runs against.

## Architecture Diagrams

`docs/architecture/workspace.dsl` is the source of truth. `make diagrams` renders it to one
PNG per view and to a single vector PDF in reading order; the output is gitignored, because a
diagram checked in next to the model it came from is a diagram that will disagree with it.

Both renderers — the Structurizr CLI and PlantUML — run in pinned containers, so rendering the
architecture needs docker but no JRE on the host. `make diagrams-install` pulls them and is the
only step that touches the network; after that the render works offline, which the target
environment requires (NFR-01). To read the model rather than export it, Structurizr Lite serves
it at <http://localhost:8088> once `make dev` is up.

Descriptions in the model are deliberately short — a box carrying a paragraph is a box nobody
reads. The reasoning lives in the ADRs, and the view descriptions link to them.

## Environments

| Environment | Provisioned by | Shape |
|---|---|---|
| Local | docker-compose | The workstation stack, with the sshd and OpenLDAP fixtures standing in for the script VM and the directory. Terraform never touches it. |
| Dev | Terraform | Three VMs: one carries the proxy, frontend, control plane, Postgres, Redis and the directory; the runner and the script VM get their own. Deployed like the rest, deliberately not drawn — see below. |
| Staging | Terraform | Production's shape from the same modules at the same versions — five instances, two backend processes, two runner processes. |
| Production | Terraform | Five instances — app, runner, data, script, directory. Backed up: the audit trail lives here and is the one thing that cannot be rebuilt. |

Each provisioned environment is one private Linode VPC, and the reverse proxy holds the only
public address (NFR-01). The runner is its own instance in all three, because it is the only
component holding SSH keys and the only one that reaches the script VM — the boundary is drawn
where the credentials are. The frontend is deliberately not separated from the control plane: it
is a renderer holding no credentials of its own, and splitting it inside the same VPC behind the
same proxy would buy a boundary nothing enforces, while putting a cross-host hop on every call
the API proxy makes.

Process counts are processes on one host. They survive a process dying, not the host dying, and
the diagrams say so rather than implying otherwise — real availability would need a second app
instance behind the balancer. Staging is worth having only while it stays production's shape,
which is why it is five instances and not a cheaper arrangement. Only staging and production get
a deployment view: dev's shape is in the table above, and a third picture would cost a page
without carrying a fact.

Only the Linode implementation is deployed. The modules are written against a provider-agnostic
interface with AWS, Azure and GCP implementations beside it — `Deployment_Portability` draws
that contract and what each provider supplies for it. The interface exists to stay honest: one
with a single implementation is that implementation with extra steps, and the first real port is
where you learn which assumptions were Linode's rather than the platform's.

## Open Decisions

Eight questions are open and each one is listed with a proposed answer in
[§5 of the requirements](docs/requirements/requirements.md#5-open-decisions). Three of them
block features rather than the walking skeleton, and one blocks pointing the walking skeleton
at a real script VM:

> **O-6 — a reference script and its setup documentation for the target environment.** Until
> that exists, the walking skeleton is built against the sshd fixture.
