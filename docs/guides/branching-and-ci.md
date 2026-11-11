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

### A promotion carries an alignment commit, and here is why

After every promotion, `staging` and `main` have `dev`'s **content**. They do not — and cannot, as
things are configured — share `dev`'s **ancestry**, and the difference is the whole of this section.

The three branches share history up to a merge base that predates the promotions, and nothing
GitHub's merge button offers moves that base. A squash writes a new commit the source branch does
not contain. So does a rebase merge: GitHub re-creates the commits with its own committer
metadata, so even a branch that is a strict descendant of the target comes out with different
hashes. (A local `git rebase` onto its own ancestor *is* an identity — which is what makes this
counter-intuitive — but GitHub's is not.)

So a pull request from `dev` into a release branch is not a fast-forward and not a small diff: it
is everything since that stale merge base — 56 commits, the last time it was measured. A second
rule stops it even earlier than that: the required checks are **strict**, so the head branch has
to contain the base branch's tip, and `dev` does not contain `staging`'s alignment commit. A
plain pull request from `dev` therefore opens as **BEHIND** while the content of the two branches
is byte-identical — the part of this that reads as a mistake and is not one. Measured rather than
reasoned: `gh pr create --base staging --head dev` between the two aligned branches reports
`mergeStateStatus: BEHIND`, `mergeable: MERGEABLE`.

By the second promotion the rebase merge conflicts, and GitHub then will not run the workflows at
all — it cannot build a merge commit — so the pull request reports *no checks* instead of a
conflict, which reads as a workflow problem and is not one.

A promotion therefore goes through an **alignment branch**: cut from the release branch, with its
tree set to `dev`'s. The head then contains the base's tip by construction, so `strict` is
satisfied, and the pull request's diff is exactly the work being promoted.

    git switch -c align-staging origin/staging
    git read-tree -u --reset origin/dev
    git commit -m "chore: align <branch> with dev"

Making a promotion a plain pull request from `dev` looks like two settings away. It is not, and
that is worth writing down because it is the obvious first idea. Turning on `allow_merge_commit`
at the repository and `required_linear_history` off on `staging` and `main` does make the *next*
promotion an ordinary pull request — and it lands as a merge commit on the release branch, a
commit that exists on no other branch. `strict` then requires the following pull request's head
branch, `dev`, to contain that commit, and the only way `dev` acquires it is a merge commit on
`dev`, which `dev`'s own `required_linear_history` forbids. So the promotion *after* the first one
is blocked unless `dev`'s linear history goes too: not a toggle, a different branching model. The
same applies to any commit a release branch holds that `dev` does not — a hotfix landed directly
on `staging` blocks the next promotion for exactly this reason.

The alignment commit is therefore not a workaround for a missing setting. It is what makes
`strict` satisfiable at all.

### When a promotion is due

The invariant is not "`staging` and `main` always equal `dev`". It is "they equal `dev` *after every
promotion*", and between promotions they legitimately differ. What makes a promotion due is whether
`dev` carries something a **deployment runs**: code, a schema migration, configuration, a unit, an
image. Docs and tests that change nothing at runtime are promoted because they are on the branch a
release is cut from, not because they need a release of their own — they ride along with the next
one.

Both directions have a cost worth naming:

- a release branch missing a migration that `dev` has is the failure to avoid: a deploy from it runs
  new code against an old schema. That is not hypothetical — it is why `runs.dispatched_at` did not
  wait for a release.
- promoting a single docs commit costs two pull requests and two full CI runs to change nothing an
  operator sees.

`make ladder` prints what each branch points at and whether its content agrees, reading `origin`
rather than a possibly stale local branch:

    dev      9b60f0d  401758c8…
    staging  1ac6666  8a190a2b…
    staging differs from dev — a promotion is due if dev carries something a deployment runs

Equal **tree** hashes are the whole test. A promotion rewrites commits, so commit hashes differ by
design and content is the only thing that can be compared.

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
| **Schema & migrations** | `make db-migrate`, `make db-check`, `make db-seed` against a Postgres service container | `schema.ts` and `drizzle/*.sql` are two descriptions of one database and nothing else compares them. They drifted once: a database built by `make db-migrate` had the directory-group columns under their old names, so it could be neither seeded nor logged into, and only a login attempt found out (#24). |
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
- `Schema & migrations`

Plus: a pull request before merging, and branches up to date before merge.

All three carry the same settings, and there are more of them than the sentence above says. What
is on the branches — read back rather than recalled:

    gh api repos/<owner>/<repo>/branches/<branch>/protection --jq '{
      checks: .required_status_checks.checks,
      strict: .required_status_checks.strict,
      linear: .required_linear_history.enabled,
      force_pushes: .allow_force_pushes.enabled,
      admins: .enforce_admins.enabled,
      reviews: .required_pull_request_reviews.required_approving_review_count,
      conversations: .required_conversation_resolution.enabled }'

`checks` rather than `contexts`: both are in the response, but only the former carries the
`app_id` that says *who* reports a check, which is what the table below asserts and what would
change if a check were ever reported by something other than Actions.

| Setting | `dev` | `staging` | `main` | What it does here |
|---|---|---|---|---|
| Required checks | the four above, `app_id` 15368 | same | same | Actions reports them, so a check that stops being reported blocks rather than passes. |
| `strict` | on | on | on | The head branch has to contain the base's tip. This is what makes the alignment branch necessary in the first place, and it is why a plain pull request from `dev` opens as *behind* — [above](#a-promotion-carries-an-alignment-commit-and-here-is-why). |
| `required_linear_history` | on | on | on | No merge commit may land on the branch. |
| `allow_force_pushes` | off | off | off | The release branch cannot be moved back onto `dev`. |
| `required_approving_review_count` | 0 | 0 | 0 | The pull request is required; a review is not. A one-person repository that required an approval would require it from nobody. |
| `required_conversation_resolution` | on | on | on | An unresolved review comment blocks the merge, including a bot's. |
| `enforce_admins` | on | on | on | Admins are bound too. Without this, the two settings above would be advice. |

### Making a promotion a plain pull request

It looks like two settings and it is not: the first promotion would land as a merge commit on the
release branch and block the second one, for the reasons worked through
[above](#a-promotion-carries-an-alignment-commit-and-here-is-why). The two settings, for the
record, are `allow_merge_commit` at the repository
(`gh api -X PATCH repos/<owner>/<repo> -F allow_merge_commit=true`) and `required_linear_history`
off on `staging` and `main`. Turning them over is a decision for whoever owns the protections —
and a decision to change the branching model, not a toggle to flip: `dev`'s own linear history,
or `strict`, has to go with them.

`Architecture model` is deliberately **not** required — it skips its own steps
when the model has not changed, and a skipped check that is required blocks
every unrelated pull request.

`End-to-end` is not required either, and that one is a judgement rather than a
mechanism: it stands up five containers, a browser and both web tiers, so it is
the slowest check by a wide margin and the one most able to fail for reasons
that are not the pull request's. It is worth requiring once it has a few weeks
of history to argue from — and worth reading on every pull request meanwhile,
because it is the only check that can tell whether the product works.

The one thing to know before enabling a new required check: the workflow file
that reports it has to be on the branch the pull request is opened *from*. All
three branches carry `ci.yml` after the first promotion, but a branch cut from a
release branch before that promotion has no checks to report, and a required
check that is never reported blocks the pull request rather than failing it.

## What is not here yet

There is **no CD workflow**, and that is a gap rather than a decision. The
sibling repository releases a container image per branch — `dev`, `staging`,
`latest` — and Scriptoria now could: `apps/*/Dockerfile` exists for all three
processes and `make docker-build` builds them. What is missing is the decision
nobody has made yet — which registry the images go to, and what credential the
workflow uses to push them.
