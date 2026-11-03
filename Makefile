.PHONY: help install dev dev-down dev-logs ports run run-frontend run-backend run-runner build lint type-check test test-e2e test-db test-db-prune db-check db-check-test db-generate db-migrate db-push db-studio db-seed docker-build docker-build-frontend docker-build-backend docker-build-runner deploy-images deploy-check deploy-check-shell deploy-check-env deploy-check-units deploy-check-nginx deploy-check-terraform diagrams diagrams-install diagrams-png diagrams-pdf diagrams-clean fixtures-key clean

# pnpm is installed via the standalone script — add its bin dir to PATH so make can find it
PNPM_HOME ?= $(HOME)/.local/share/pnpm
export PATH := $(PNPM_HOME)/bin:$(PATH)
PNPM := pnpm

# Podman users: `make COMPOSE="podman compose" dev`. The reference deployment is
# rootless Podman (see docs/architecture/workspace.dsl); the dev stack only needs
# something that speaks compose.
COMPOSE ?= docker compose
COMPOSE_FILE := infra/docker-compose.dev.yml

# ── The dev stack's host ports ────────────────────────────────────────────────
# Read back out of the addresses the apps are configured with, rather than
# declared a second time here. The apps take a full URL and compose takes a port,
# so a machine that already runs another project's Postgres — which is the whole
# reason the defaults are 5433 and 8089 rather than 5432 and 8088 — moves this
# stack by editing the one address in .env that collided, and the containers, the
# URLs and the test databases all follow together. Two lists is how the two come
# to disagree.
#
# `port_in(<variable>)` is the port out of the address that variable holds in
# .env. Nothing matches when .env is absent, and compose then falls back to the
# default in its own `${VAR:-default}`.
port_in = $(shell sed -n 's#^$1=.*:\([0-9][0-9]*\).*$$#\1#p' .env 2>/dev/null | head -1)

POSTGRES_PORT ?= $(call port_in,DATABASE_URL)
REDIS_PORT ?= $(call port_in,REDIS_URL)
LDAP_PORT ?= $(call port_in,LDAP_URL)
# Nothing reads this one out of an address: Structurizr is read by a person, not
# a process, and no URL in .env points at it.
STRUCTURIZR_PORT ?= 8089

# Exported so compose interpolates them. The sshd fixture's port is deliberately
# not one of these — see the note in infra/docker-compose.dev.yml.
export POSTGRES_PORT REDIS_PORT LDAP_PORT STRUCTURIZR_PORT

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  install               install all workspace dependencies"
	@echo "  dev                   start the dev stack (postgres, redis, openldap, sshd fixture, structurizr)"
	@echo "  ports                 show the host ports the dev stack resolved to (they follow .env)"
	@echo "  dev-down              stop the dev stack"
	@echo "  dev-logs              follow the dev stack logs"
	@echo "  run                   start frontend, backend and runner together (requires: make dev)"
	@echo "  run-frontend          start the Next.js frontend on :3000"
	@echo "  run-backend           start the Next.js backend on :3001 (custom server, see ADR-007)"
	@echo "  run-runner            start the runner worker (no listening port)"
	@echo "  build                 build all workspace packages"
	@echo "  lint                  lint all apps and packages"
	@echo "  type-check            TypeScript type-check everything"
	@echo "  test                  run unit and integration tests (the backend leg needs the dev stack)"
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
	@echo "  deploy-images         build the three images and pack them, with the stores, into one tarball"
	@echo "  deploy-check          check the deployment layer: units, proxy, configuration"
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
	@echo "  dev stack: postgres:$(POSTGRES_PORT) redis:$(REDIS_PORT) openldap:$(LDAP_PORT) — make ports"
	$(COMPOSE) -f $(COMPOSE_FILE) up -d --wait

dev-down:
	$(COMPOSE) -f $(COMPOSE_FILE) down

dev-logs:
	$(COMPOSE) -f $(COMPOSE_FILE) logs -f

# What the stack resolved to. Worth asking when a port was moved and something is
# still talking to the old one.
ports:
	@echo "  postgres    localhost:$(POSTGRES_PORT)"
	@echo "  redis       localhost:$(REDIS_PORT)"
	@echo "  openldap    localhost:$(LDAP_PORT)"
	@echo "  sshd        localhost:2222  (fixed — infra/docker-compose.dev.yml)"
	@echo "  structurizr http://localhost:$(STRUCTURIZR_PORT)"

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
E2E_DATABASE_URL ?= postgres://postgres:postgres@localhost:$(POSTGRES_PORT)/scriptoria_e2e

# One requirement can be run on its own, by naming any Playwright filter:
#
#   make test-e2e E2E_SPECS=tests/05-stop.spec.ts
#
# CI gives each requirement its own check with this, so a red end-to-end run
# names the requirement it broke instead of "the suite is broken" — and so the
# failure lands next to the requirement's own specs rather than in a five-minute
# log. Empty means the whole suite, which is what a developer wants.
E2E_SPECS ?=

# The suite checks the stack is up before it starts anything (src/global-setup.ts),
# on the ports it is told about — and those have to be the ports .env named, or a
# stack that was moved reads as a stack that is not running.
test-e2e: test-db
	@echo "  e2e database: $(E2E_DATABASE_URL)"
	@DATABASE_URL="$(E2E_DATABASE_URL)" $(PNPM) --filter @scriptoria/db db:migrate
	@DATABASE_URL="$(E2E_DATABASE_URL)" $(PNPM) --filter @scriptoria/db db:seed
	@E2E_PG_PORT=$(POSTGRES_PORT) E2E_REDIS_PORT=$(REDIS_PORT) E2E_LDAP_PORT=$(LDAP_PORT) \
	  DATABASE_URL="$(E2E_DATABASE_URL)" $(PNPM) test:e2e $(if $(E2E_SPECS),-- $(E2E_SPECS),)

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

# The terminal's WebSocket address is compiled into the frontend bundle rather
# than read from the environment at runtime (see apps/frontend/Dockerfile), so
# it is an argument to the build and differs per environment.
TERMINAL_WS_URL ?= ws://localhost:3001

docker-build-frontend:
	docker build -t scriptoria-frontend:latest \
	  --build-arg NEXT_PUBLIC_TERMINAL_WS_URL=$(TERMINAL_WS_URL) \
	  -f apps/frontend/Dockerfile .

docker-build-backend:
	docker build -t scriptoria-backend:latest -f apps/backend/Dockerfile .

docker-build-runner:
	docker build -t scriptoria-runner:latest -f apps/runner/Dockerfile .

docker-build: docker-build-frontend docker-build-backend docker-build-runner

# ── Deployment ─────────────────────────────────────────────────────────────────
# What runs in a provisioned environment. Checked here rather than on a host,
# because every one of these failures is one you would otherwise meet as a container
# that will not start, with the reason three layers away.
DEPLOY_DIR := infra/deploy
TF_DIR := infra/terraform

# The two things here that want a container or a tool of their own: `nginx -t` is
# the only real parser for an nginx configuration and it is the same parser the
# proxy runs; nothing parses HCL except Terraform.
RUNTIME ?= docker
NGINX_IMAGE ?= nginx:1.27-alpine
TERRAFORM ?= terraform

deploy-check: deploy-check-shell deploy-check-env deploy-check-units deploy-check-nginx deploy-check-terraform

deploy-check-shell:
	@for f in $(DEPLOY_DIR)/scripts/*.sh $(TF_DIR)/checks/*.sh; do sh -n $$f || exit 1; done
	@echo "  deployment scripts parse"

# The example is the deployment's configuration file with placeholders in it, so it
# is checked like one — and the checker is checked against the mistakes it claims
# to catch.
deploy-check-env:
	@$(DEPLOY_DIR)/scripts/check-env.sh > /dev/null && echo "  app.env.example satisfies the deployment's rules"
	@$(DEPLOY_DIR)/scripts/check-env.test.sh > /dev/null && echo "  ...and the rules refuse what they claim to"

# `systemd-analyze verify` reads the whole unit graph, so it also reports on the
# machine it runs on — GitHub's runner has its own units with options its systemd
# has deprecated. Only lines that name the unit being checked are ours, and the
# only one of those that is still not an error is a missing ExecStart binary:
# podman is on the hosts this deploys to and not on a build machine.
deploy-check-units:
	@fail=0; \
	for f in $(DEPLOY_DIR)/systemd/*; do \
	  name=$$(basename "$$f"); stem=$${name%%.*}; stem=$${stem%%@*}; \
	  out=$$(systemd-analyze verify "$$f" 2>&1 \
	    | grep -F "$$stem" | grep -v 'is not executable' || true); \
	  if [ -n "$$out" ]; then printf '%s\n' "$$out"; fail=1; fi; \
	done; \
	if [ $$fail -ne 0 ]; then exit 1; fi; \
	echo "  systemd units are valid"

# A throwaway certificate, because `nginx -t` loads the pair the configuration
# names and would otherwise fail on the one file that is an operator's to place.
deploy-check-nginx:
	@tmp=$$(mktemp -d); trap 'rm -rf $$tmp' EXIT; \
	openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=scriptoria.invalid" \
	  -keyout $$tmp/privkey.pem -out $$tmp/fullchain.pem 2> /dev/null; \
	$(RUNTIME) run --rm \
	  --entrypoint nginx \
	  --volume "$(PWD)/$(DEPLOY_DIR)/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
	  --volume "$(PWD)/$(DEPLOY_DIR)/nginx/upstreams:/etc/nginx/scriptoria/upstreams:ro" \
	  --volume "$$tmp:/etc/scriptoria/tls:ro" \
	  $(NGINX_IMAGE) -t 2>&1; \
	echo "  nginx accepts the proxy configuration"

# Terraform: the five implementations that create the hosts. `validate` is as far
# as any of this can go without an account — it checks the code against the
# provider's real schema, which is where the mistakes worth catching are, and it is
# honest about not having created anything.
deploy-check-terraform:
	@for p in linode aws gcp azure stackit; do \
	  ( cd $(TF_DIR)/$$p && $(TERRAFORM) init -backend=false -input=false > /dev/null \
	    && $(TERRAFORM) validate > /dev/null ) || exit 1; \
	done
	@echo "  the five implementations validate against their providers"
	@$(TERRAFORM) fmt -check -recursive $(TF_DIR) && echo "  terraform is formatted"
	@$(TF_DIR)/check-interface.py
	@$(TF_DIR)/checks/host-prep.sh

# The release's images as one tarball. The deployment carries them rather than
# pulling them: NFR-01 puts every provisioned environment in a network with no
# route out, so there is no registry to pull from and nothing here may depend on
# one. The stores are in it too — they are images the data instance needs, and a
# host that has to reach a registry for PostgreSQL is a host that will not come up.
DEPLOY_IMAGES := scriptoria-frontend:latest scriptoria-backend:latest scriptoria-runner:latest \
                 postgres:16-alpine redis:7-alpine bitnamilegacy/openldap:2.6

deploy-images: docker-build
	$(RUNTIME) pull $(wordlist 4,$(words $(DEPLOY_IMAGES)),$(DEPLOY_IMAGES))
	$(RUNTIME) save --output scriptoria-images.tar $(DEPLOY_IMAGES)
	@echo "  wrote scriptoria-images.tar — load it with $(DEPLOY_DIR)/scripts/load-images.sh"

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
