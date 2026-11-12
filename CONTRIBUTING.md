# Contributing

The conventions here are enforced rather than suggested: a policy checker, a branch ladder and a
required check set. This page is the short version; the long version is in
[`docs/guides/branching-and-ci.md`](docs/guides/branching-and-ci.md).

## Set up

Node ≥ 22 and pnpm 9.15.4 (`corepack enable`), a container runtime (Docker or Podman), and
`openssl` if you intend to run the deployment checks.

    make install      # workspace dependencies
    make dev          # postgres, redis, openldap, the sshd fixture, structurizr
    make db-migrate   # schema
    make db-seed      # the reference area and a login to try
    make run          # frontend :3000, backend :3001, runner

`make help` lists everything. The README explains what each piece is for.

## Before opening a pull request

    make type-check    # every workspace package
    make lint
    make test
    make build
    make env-check     # every setting the code reads is in both .env examples

And, depending on what you touched:

    make test-e2e      # anything a person does through the browser — needs `make dev`
    make mutation      # packages/core; the run fails below the score in stryker.conf.json
    make deploy-check  # infra/: units, proxy, env rules, Terraform

CI runs the same commands through the Makefile, which is the point: if your machine and CI disagree
about what "lint" means, one of them is wrong.

## A test has to be able to fail

A test that stays green with the defect put back is not evidence — it happened twice here, and both
times the test looked decisive. Before you claim a fix is covered, undo the fix and watch the test
go red, or run `make mutation` and read the survivors. Say which you did in the pull request.

## Branches and commits

Pull requests go against **`dev`**. `dev` → `staging` → `main` promotions are separate pull requests
made of alignment commits; `make ladder` prints whether one is due and whether the release branches
carry `dev`'s content. Never force-push a release branch, and never promote by rewriting one.

Commits read `type(scope): imperative subject`, with `type` one of `feat`, `fix`, `test`, `docs`,
`ci`, `chore`. One concern per pull request; the body says what was verified and what was not.

## Decisions and documentation

- A change to a contract, a safety property or an operational assumption gets an **ADR** in
  `docs/architecture/adr/` — numbered, and added to the index there.
- A change to a component or a relationship is also a change to the C4 model:
  `docs/architecture/workspace.dsl`, rendered with `make diagrams`.
- Claims in the guides are marked for what they are. "Verified" means somebody ran it; where nobody
  has, the guide says so and names what would close it.

## Policy as code

`python3 tools/policy_check.py` runs over the files you changed and in CI over the pull request.
It refuses symlinks, build artifacts, secrets, absolute home paths, conflict markers, files without
a trailing newline, and anything that does not parse in its language. `policy.json` configures it;
the rules this repository turns on are the hygiene, syntax and Node ones.

## Dependencies

The lockfile is the decision: CI installs with `pnpm install --frozen-lockfile`, so a manifest change
and its `pnpm-lock.yaml` belong in the same commit. Dependabot opens the routine updates weekly. A
new dependency is worth a sentence in the pull request saying what it buys and what it costs.

## Security and licence

Report vulnerabilities as described in [`SECURITY.md`](SECURITY.md) — not in a public issue.

This project is licensed under the Apache License 2.0 (`LICENSE`). Unless you state otherwise, any
contribution you intentionally submit for inclusion is under those terms, per section 5 of that
licence.
