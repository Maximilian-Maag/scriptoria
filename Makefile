.PHONY: help install dev dev-down dev-logs run run-frontend run-backend run-runner build lint type-check test test-e2e test-db test-db-prune db-check db-check-test db-generate db-migrate db-push db-studio db-seed docker-build docker-build-frontend docker-build-backend docker-build-runner diagrams diagrams-install diagrams-png diagrams-pdf diagrams-clean fixtures-key clean

# pnpm is installed via the standalone script — add its bin dir to PATH so make can find it
PNPM_HOME ?= $(HOME)/.local/share/pnpm
export PATH := $(PNPM_HOME)/bin:$(PATH)
PNPM := pnpm

# Podman users: `make COMPOSE="podman compose" dev`. The reference deployment is
# rootless Podman (see docs/architecture/workspace.dsl); the dev stack only needs
# something that speaks compose.
COMPOSE ?= docker compose
COMPOSE_FILE := infra/docker-compose.dev.yml

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  install               install all workspace dependencies"
	@echo "  dev                   start the dev stack (postgres, redis, openldap, sshd fixture, structurizr)"
	@echo "  dev-down              stop the dev stack"
	@echo "  dev-logs              follow the dev stack logs"
	@echo "  run                   start frontend, backend and runner together (requires: make dev)"
	@echo "  run-frontend          start the Next.js frontend on :3000"
	@echo "  run-backend           start the Next.js backend on :3001 (custom server, see ADR-007)"
	@echo "  run-runner            start the runner worker (no listening port)"
	@echo "  build                 build all workspace packages"
	@echo "  lint                  lint all apps and packages"
	@echo "  type-check            TypeScript type-check everything"
	@echo "  test                  run unit and integration tests"
	@echo "  test-e2e              run the Playwright end-to-end suite (needs a live stack: make dev)"
	@echo "                        E2E_SPECS=tests/05-stop.spec.ts runs one requirement's specs"
	@echo "  test-db               create the test and e2e databases in the running Postgres"
	@echo "  test-db-prune         drop the per-directory test databases"
	@echo "  db-check              fail if schema.ts and the migrations disagree"
	@echo "  db-check-test         test the drift check itself (needs a Postgres it can create a database on)"
	@echo "  db-generate           generate a Drizzle migration from the schema"
	@echo "  db-migrate            apply pending migrations (the working path)"
	@echo "  db-push               push the schema straight to the database — see the note below"
	@echo "  db-studio             open Drizzle Studio"
	@echo "  db-seed               seed the initial root group mapping and the reference area"
	@echo "  docker-build          build all three images"
	@echo "  diagrams              render the C4 diagrams from docs/architecture/workspace.dsl (PNG + PDF)"
	@echo "  diagrams-png          render PNG only"
	@echo "  diagrams-pdf          render one vector PDF of the C4 diagrams in reading order"
	@echo "  diagrams-clean        remove generated diagrams (the pinned renderer images are kept)"
	@echo "  fixtures-key          generate the dev SSH keypair the runner uses against the sshd fixture"
	@echo "  clean                 remove build artifacts"

install:
	$(PNPM) install

# Everything the apps talk to, and nothing the apps themselves run in — the three
# Node processes run locally via `make run` so a restart is a restart, not a rebuild.
dev:
	$(COMPOSE) -f $(COMPOSE_FILE) up -d --wait

dev-down:
	$(COMPOSE) -f $(COMPOSE_FILE) down

dev-logs:
	$(COMPOSE) -f $(COMPOSE_FILE) logs -f

run:
	$(PNPM) --parallel --filter frontend --filter backend --filter runner dev

run-frontend:
	$(PNPM) --filter frontend dev

run-backend:
	$(PNPM) --filter backend dev

run-runner:
	$(PNPM) --filter runner dev

build:
	$(PNPM) build

lint:
	$(PNPM) lint

type-check:
	$(PNPM) --parallel --filter './apps/*' --filter './packages/*' --filter e2e exec tsc --noEmit

test:
	$(PNPM) --filter backend test
	$(PNPM) --filter runner test
	$(PNPM) --filter frontend test
	$(PNPM) --filter '@scriptoria/*' test

# ── End-to-end ────────────────────────────────────────────────────────────────
# The suite drives the real interface against the real stack. It needs postgres,
# redis, the directory fixture and the script-VM fixture up — `make dev` — and
# nothing else: Playwright starts the frontend, the backend and the runner
# itself, so a stale build already listening on :3000 cannot be what the suite
# reports on.
#
# It runs against its own database rather than the one `make run` uses, so a
# suite run cannot rewrite the area an operator is looking at, and so the state
# it asserts on is the state its own migrate-and-seed put there.
E2E_DATABASE_URL ?= postgres://postgres:postgres@localhost:5433/scriptoria_e2e

# One requirement can be run on its own, by naming any Playwright filter:
#
#   make test-e2e E2E_SPECS=tests/05-stop.spec.ts
#
# CI gives each requirement its own check with this, so a red end-to-end run
# names the requirement it broke instead of "the suite is broken" — and so the
# failure lands next to the requirement's own specs rather than in a five-minute
# log. Empty means the whole suite, which is what a developer wants.
E2E_SPECS ?=

test-e2e: test-db
	@echo "  e2e database: $(E2E_DATABASE_URL)"
	@DATABASE_URL="$(E2E_DATABASE_URL)" $(PNPM) --filter @scriptoria/db db:migrate
	@DATABASE_URL="$(E2E_DATABASE_URL)" $(PNPM) --filter @scriptoria/db db:seed
	@DATABASE_URL="$(E2E_DATABASE_URL)" $(PNPM) test:e2e $(if $(E2E_SPECS),-- $(E2E_SPECS),)

# The backend suite creates its own database on first run — one per working
# directory, so two runs cannot truncate each other's tables. This target only
# covers the e2e database, which the Playwright stack expects to exist.
# Idempotent, so it is safe to re-run.
test-db:
	@for db in scriptoria_test scriptoria_e2e; do \
	  $(COMPOSE) -f $(COMPOSE_FILE) exec -T postgres psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$$db'" | grep -q 1 \
	    && echo "  exists  $$db" \
	    || { $(COMPOSE) -f $(COMPOSE_FILE) exec -T postgres createdb -U postgres "$$db" && echo "  created $$db"; }; \
	done

test-db-prune:
	@dbs="$$($(COMPOSE) -f $(COMPOSE_FILE) exec -T postgres psql -U postgres -tAc \
	  "SELECT datname FROM pg_database WHERE datname LIKE 'scriptoria_test\_%'")" \
	  || { echo "  could not list databases — is the dev stack up?" >&2; exit 1; }; \
	for db in $$dbs; do \
	  [ -n "$$db" ] || continue; \
	  $(COMPOSE) -f $(COMPOSE_FILE) exec -T postgres dropdb -U postgres --if-exists "$$db" && echo "  dropped $$db"; \
	done

db-generate:
	$(PNPM) --filter @scriptoria/db db:generate

# The database the migrations build, against the database the code believes in.
# They are two descriptions of one thing and nothing else compares them: the
# directory-group columns were renamed in the schema with no migration to follow,
# and a `make db-migrate` database silently could not seed or log in (#24).
#
# Needs a migrated database — `make db-migrate` first, which is exactly what the
# job in CI and the deployment's unit both do.
db-check:
	$(PNPM) --filter @scriptoria/db db:check

# The drift check's own regression suite. It builds a throwaway database from
# the migrations, makes each mutation the check exists to catch — an index that
# has lost its uniqueness, an index moved to another column, an enum value
# renamed — and asserts each is reported (#59). It needs a Postgres it can
# create a database on, which is why CI runs it in the "Schema & migrations"
# job; it skips itself where there is no DATABASE_URL, so `make test` is
# unaffected on a machine with no stack up.
db-check-test:
	$(PNPM) --filter @scriptoria/db test

db-migrate:
	$(PNPM) --filter @scriptoria/db db:migrate

# Currently fails against this schema: drizzle-kit cannot introspect the
# expression index on area_entitlements (lower(directory_group)). Kept because
# it is the right tool once that is fixed upstream; use db-migrate meanwhile,
# which is what the deployment runs anyway.
db-push:
	$(PNPM) --filter @scriptoria/db db:push

db-studio:
	$(PNPM) --filter @scriptoria/db db:studio

db-seed:
	$(PNPM) --filter @scriptoria/db db:seed

docker-build-frontend:
	docker build -t scriptoria-frontend:latest -f apps/frontend/Dockerfile .

docker-build-backend:
	docker build -t scriptoria-backend:latest -f apps/backend/Dockerfile .

docker-build-runner:
	docker build -t scriptoria-runner:latest -f apps/runner/Dockerfile .

docker-build: docker-build-frontend docker-build-backend docker-build-runner

# The dev SSH keypair the runner presents to the sshd fixture. Generated, never
# committed — .gitignore has the path. Nothing outside the dev stack accepts it.
fixtures-key:
	@mkdir -p infra/sshd/keys
	@test -f infra/sshd/keys/id_ed25519 || \
	  ssh-keygen -t ed25519 -N '' -C 'scriptoria-dev-runner' -f infra/sshd/keys/id_ed25519
	@cp infra/sshd/keys/id_ed25519.pub infra/sshd/authorized_keys
	@echo "Dev runner key in infra/sshd/keys — restart the stack to pick it up"

# Pulls the two pinned renderer images. Separate from `diagrams` because it is
# the only step that needs the network — once they are local, rendering is
# offline, which the target environment requires (NFR-01).
diagrams-install:
	@node_modules/.bin/tsx scripts/diagramTools.ts

# The C4 pictures, from docs/architecture/workspace.dsl — the model is the source
# of truth. Both formats by default: --png writes line art (JPEG's block artefacts
# would land on the glyph edges), --pdf writes ONE vector PDF of the C4 diagrams
# in reading order.
#
# structurizr-cli and PlantUML run in pinned containers, so rendering the
# architecture needs no JRE on the host — docker is already required for the dev
# stack, a Java toolchain would be a second prerequisite installed for nothing
# but pictures. Everything written here is gitignored: the DSL is what is
# reviewed, never a checked-in render of it.
diagrams: diagrams-install
	@node_modules/.bin/tsx scripts/diagrams.ts --png --pdf

diagrams-png: diagrams-install
	@node_modules/.bin/tsx scripts/diagrams.ts --png

diagrams-pdf: diagrams-install
	@node_modules/.bin/tsx scripts/diagrams.ts --pdf

diagrams-clean:
	@rm -rf docs/architecture/diagrams .diagrams
	@echo "Removed the generated diagrams and their PlantUML intermediates."
	@echo "The pinned renderer images are kept — 'docker image rm' them by hand if you want the space."

clean:
	rm -rf apps/frontend/.next apps/backend/.next apps/runner/dist packages/*/dist
