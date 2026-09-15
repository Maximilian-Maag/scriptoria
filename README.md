# Scriptoria

A web frontend through which teams select, start, interactively drive and collect the results
of **existing Linux scripts** that live on a script VM — without Linux, shell or environment
knowledge, and without jump-server handwork.

The platform only *presents* and *starts* scripts. Responsibility for the content and the
effect of a script stays with the script owner — the system context diagram makes this
structural: **there is no edge from Scriptoria to the target systems.** It never reaches a
network device, a firewall or a hypervisor itself. The scripts do, with their own credentials.

## Status

Early. The architecture model, the requirements, the shared packages and the control plane's
authentication path are built and tested; the frontend, the runner and the remaining backend
routes are not yet. The `Project Structure` section below describes the intended layout, not
what is on disk today — directories marked *(planned)* do not exist yet.

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
| Deployment | Rootless containers under systemd, behind a reverse proxy with TLS |

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
│   ├── frontend/               # (planned) Next.js 15 UI + API proxy (port 3000)
│   │   └── src/
│   │       ├── app/            # App Router: login, areas, catalog, console, results, admin
│   │       │   └── api/proxy/  # The browser's only REST route to the backend
│   │       └── lib/
│   │           ├── terminal/   # xterm.js mount, binary WebSocket hook, resume-from-id
│   │           └── api/        # Typed client built on packages/contracts
│   ├── backend/                # Next.js 15 API app + terminal WebSocket (port 3001)
│   │   ├── server.ts           # Custom entrypoint: Next.js handler + ws upgrade (ADR-007)
│   │   ├── drizzle/            # Generated migrations
│   │   └── src/
│   │       ├── app/api/        # Thin route handlers: validate → service → toResponse
│   │       └── lib/
│   │           ├── services/   # All domain logic, returns Result<T>
│   │           ├── db/         # Drizzle client, schema, repository layer
│   │           ├── auth/       # LDAP bind, group resolution, server-side sessions
│   │           └── stream/     # Stream gateway: Redis stream ⇄ WebSocket
│   └── runner/                 # (planned) SSH/PTY worker — no port, deliberately not Next.js
│       └── src/
│           ├── driver/         # ExecutionTarget interface (see ADR-001)
│           ├── ssh/            # ssh2 connection, PTY session, staged abort, SFTP
│           └── stream/         # Redis stream publisher, stdin subscriber
├── packages/
│   ├── contracts/              # Zod schemas + inferred types, shared by all three apps
│   ├── core/                   # Pure domain logic: authorization rules, header parsing, cron
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
│   └── deploy/                 # (planned) reverse proxy config and systemd units
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
make db-push db-seed    # schema and the reference area
make run                # frontend :3000, backend :3001, runner
```

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

## Open Decisions

Eight questions are open and each one is listed with a proposed answer in
[§5 of the requirements](docs/requirements/requirements.md#5-open-decisions). Three of them
block features rather than the walking skeleton, and one blocks pointing the walking skeleton
at a real script VM:

> **O-6 — a reference script and its setup documentation for the target environment.** Until
> that exists, the walking skeleton is built against the sshd fixture.
