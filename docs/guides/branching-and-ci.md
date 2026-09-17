# Branching and CI

Three long-lived branches, one direction of travel, and a set of checks that run
once — on the pull request, before anything merges.

## The branches

| Branch | What it is | How code arrives |
|---|---|---|
| **`dev`** | The integration branch and the default one. What is built but not yet released. | Pull request from a topic branch. |
| **`staging`** | What is being validated for release. | Pull request from `dev`. |
| **`main`** | What is released. | Pull request from `staging`. |

```
topic branch ──PR──▶ dev ──PR──▶ staging ──PR──▶ main
```

Code moves in that direction and only in that direction. A fix that has to reach
`main` in a hurry still goes `dev → staging → main`; the three merges take
minutes and the alternative — landing on `main` and back-merging afterwards — is
how `main` and `dev` start disagreeing about what is in a release.

`dev` is the default branch, so a clone and a fresh topic branch start from what
is actually being built rather than from the last release.

## Topic branches

Named `<kind>/<slug>`, where the kind says what the change is:

| Prefix | For |
|---|---|
| `feat/` | New behaviour |
| `fix/` | A defect |
| `docs/` | Documentation only |
| `ci/` | The pipeline or the tooling around it |
| `refactor/` | Behaviour-preserving change |
| `test/` | Tests with no production change |

Branch off `dev`, PR back into `dev`. One topic per branch: a branch that
changes two unrelated things is a branch that cannot be reverted.

## What runs, and when

`.github/workflows/ci.yml` runs on **pull requests only**. A push to `dev`,
`staging` or `main` is a merge of something CI has already passed, so running it
again answers a question that was answered a moment earlier. The branch
protections are what make that safe — not the workflow file.

| Check | What it does | Why it is its own job |
|---|---|---|
| **Type-check & Lint** | `make type-check`, `make lint` | Both halves share an install and take seconds. Splitting them would double the setup cost to parallelise ninety seconds. |
| **Test** | One leg per package: `@scriptoria/*`, runner, frontend — and the backend in its own job, with a Postgres service | A slow suite stops being every suite's problem, and a red frontend does not hide a red runner. The backend is separate because it is the only one needing a service: its authorisation tests run against a real database, since the bug worth catching is a `where` clause that stopped filtering. |
| **Build** | `make build` | Catches what type-checking cannot: both web tiers are Next.js applications whose routes are collected and compiled at build time. |
| **Architecture model** | `make diagrams-png`, only when the model changed | `workspace.dsl` is the source of truth and its renders are gitignored, so nothing else would notice a model that stopped parsing. |
| **End-to-end** | `make dev`, then `make test-e2e` | The only check that exercises the product as a person meets it — a browser, a real LDAP bind, a real PTY, real files back over SFTP. Everything above it can be green while the platform does nothing. |

Everything runs through the **Makefile**, so CI and a developer's machine run
the same command and cannot drift into disagreeing about what "lint" means.

Concurrency is `cancel-in-progress`: a second push to the same branch makes the
first run's answer worthless, so it stops paying for it.

### Two details worth knowing before you edit the workflow

**`Test` is an aggregating job.** The matrix legs report one check each
(`Test (runner)`, `Test (backend)`, …), and a branch protection cannot require a
matrix. So a separate `Test` job depends on the matrix and passes or fails with
it. That is the name the protections require, which means the matrix can be
reshaped — a leg added, a leg split — without anybody editing a protection rule
first. Add a *new* required job and it gates nothing until it is added to both
`dev` and `staging` protections; add a step to an existing job and it counts the
moment it merges.

**The build needs no environment.** `packages/config` validates lazily —
`defineConfig` returns a getter and nothing calls it while a module is being
imported — so a build needs no database URL, no directory and no secret. That is
a property being kept, not an omission: if a module ever starts reading
configuration at import time, the build job goes red and says so, which is a
better moment to learn it than the first deploy.

### Third-party actions are pinned by commit

Every `uses:` names a full commit SHA with the version in a trailing comment. A
tag is mutable and a moved tag is a supply-chain change nobody reviewed. This
matches NFR-01, which wants a build that does not depend on what a registry
happens to serve today.

## Branch protection

Set on `dev`, `staging` and `main`, requiring these checks by exact name:

- `Type-check & Lint`
- `Test`
- `Build`

Plus: a pull request before merging, and branches up to date before merge.

`Architecture model` is deliberately **not** required — it skips its own steps
when the model has not changed, and a skipped check that is required blocks
every unrelated pull request.

`End-to-end` is not required either, and that one is a judgement rather than a
mechanism: it stands up five containers, a browser and both web tiers, so it is
the slowest check by a wide margin and the one most able to fail for reasons
that are not the pull request's. It is worth requiring once it has a few weeks
of history to argue from — and worth reading on every pull request meanwhile,
because it is the only check that can tell whether the product works.

## What is not here yet

There is **no CD workflow**, and that is a gap rather than a decision. The
sibling repository releases a container image per branch — `dev`, `staging`,
`latest` — and Scriptoria now could: `apps/*/Dockerfile` exists for all three
processes and `make docker-build` builds them. What is missing is the decision
nobody has made yet — which registry the images go to, and what credential the
workflow uses to push them.
