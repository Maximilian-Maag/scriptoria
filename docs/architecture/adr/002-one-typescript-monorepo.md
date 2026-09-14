# ADR-002 — One TypeScript monorepo, Next.js on both web tiers

**Status:** Accepted
**Context:** NFR-11, NFR-01

## Context

The obvious alternative to this stack is a split one: a TypeScript frontend and a Python
control plane, with `asyncssh` for execution and SQLAlchemy plus Alembic for persistence. That
is a serious option rather than a straw man. The surrounding ecosystem — the scripts
themselves, the operational tooling around them, the working knowledge of the people who own
them — is Python and Linux, so a Python control plane would be maintainable by the same people
who maintain the scripts.

## Decision

One pnpm workspace, all TypeScript, with **Next.js on both web tiers**:

| Concern | Split-stack alternative | Here |
|---|---|---|
| Frontend | Next.js | unchanged |
| Control plane | FastAPI / Python | **Next.js / Node** (`apps/backend`) |
| Terminal WebSocket | Uvicorn WebSocket route | **`ws` mounted on a custom Next.js server** — see ADR-007 |
| SSH and PTY | asyncssh | **ssh2** |
| Validation | Pydantic | **Zod**, shared with the frontend |
| ORM and migrations | SQLAlchemy + Alembic | **Drizzle ORM + drizzle-kit** |
| LDAP | ldap3 | **ldapts** |
| Cron arithmetic | croniter | **cron-parser** |
| Tests | pytest + Testcontainers | **Vitest + Testcontainers + Playwright** |

The runner is the one exception and is deliberately **not** Next.js: it listens on no port and
serves no page. There is no web application there for NFR-11 to apply to — only a worker
holding SSH sessions. It is plain Node and TypeScript.

Everything the split-stack option would also have decided stands unchanged: the container
split, SSH rather than an agent, Redis streams for terminal transport, server-side sessions,
PostgreSQL, rootless containers under systemd, and a reverse proxy in front.

## Why

- **NFR-11 wants one framework across both web tiers**, and that is sufficient on its own. A
  Python control plane does not satisfy it.
- **The request contracts are shared, not restated.** The Zod schema that validates a request
  in the backend is the same one that types the call in the frontend, and it generates the
  OpenAPI document. In a split stack that contract is written twice and drifts — and the
  drift shows up as a runtime error in the tier that was not changed.
- **One toolchain, one CI, one dependency mirror.** In an isolated zone every dependency has
  to come from an internal mirror; one ecosystem is one mirror to maintain and one supply
  chain to review, not two.
- **Drizzle over Prisma matters specifically here.** Prisma downloads a query-engine binary at
  install time; in an air-gapped zone that is an obstacle on every deploy. Drizzle is plain
  TypeScript and SQL.

## What this costs, stated plainly

The split-stack argument was not wrong. The people who own the scripts work in Python, and a
Node backend means **they cannot maintain the platform that runs their scripts**. That is a
genuine loss and this decision accepts it rather than quietly absorbing it. Two things limit
the damage:

- The runner sits behind the `ExecutionTarget` interface from ADR-001. The component that
  actually touches the scripts is the smallest and most replaceable one, and a Python
  implementation of it remains possible without touching anything else. **If the script
  owners' team needs a piece of this system they can maintain, this is the piece.**
- The platform never contains script logic. Nothing a script owner needs to change lives in
  this repository — by NFR-06, that is the whole point.

## Consequences

- `ssh2` replaces `asyncssh`. It is mature and supports PTY allocation, `exec`, SFTP on the
  same connection and host key verification. It shares `asyncssh`'s weakness on channel
  signals, which ADR-003 addresses regardless of language.
- Hosting the terminal WebSocket inside Next.js is the one place where this decision costs
  something structural. ADR-007 is that decision on its own.
- The repository layout is conventional for a workspace of this shape: `apps/*`,
  `packages/*`, a `Makefile` as the entry point, Structurizr DSL as the architecture source
  of truth, and the requirements in `docs/requirements`.
