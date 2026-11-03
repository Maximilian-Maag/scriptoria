# The hosts

Terraform's job here is one thing: **make the machines exist**. Instances, a private
network, a firewall, one public address. It does not install the platform — that is
`infra/deploy`, applied by an operator with `app.env` in hand — and it does not know
what the application is.

That boundary is deliberate and it is what makes the provider question small. The
runtime is identical everywhere (Linux, systemd, rootless podman, nginx), so the only
thing that changes between providers is how machines are created and how reachability
is expressed. Five implementations, one contract, and nothing above it that knows
which one ran.

## What an operator does

```sh
cd infra/terraform/<provider>

# One state per environment per provider. The bucket, the prefix and the credentials
# come from here rather than from the code — `terraform init` with no -backend-config
# fails on purpose, because a state that lands in a default location is a state
# nobody chose.
terraform init -backend-config=bucket=... -backend-config=key=<env>.tfstate -reconfigure

# The environment's shape, plus what only the operator knows: the key they hold the
# private half of, and who may reach SSH. Neither is in the repository.
terraform plan  -var-file=../environments/<env>.tfvars -var-file=~/scriptoria-<env>.tfvars
terraform apply -var-file=../environments/<env>.tfvars -var-file=~/scriptoria-<env>.tfvars

terraform output instances      # every machine, by role, with its address
terraform output public_address # what the environment's DNS record points at
```

Then: point DNS at `public_address`, and follow
[docs/guides/deployment.md](../../docs/guides/deployment.md) — write `app.env` on
each host from the addresses above, load the release's images, start the units. The
apply prints the addresses precisely so that step is mechanical.

`<env>` is `dev` (three machines: one carries the proxy, the frontend, the control
plane, both stores and the directory), `staging` or `prod` (five, with the data
instance and the directory on their own machines). The shapes are in
`environments/`; the architecture model, `docs/architecture/workspace.dsl`, is where
they are argued.

## The contract

Every implementation declares the same required inputs and produces the same outputs.
`check-interface.py` fails the build when one drifts, because an implementation that
wanted a variable the others do not ask for would be a deployment that only runs on
that provider.

| Required input | |
| --- | --- |
| `environment` | `dev`, `staging` or `prod` — names everything |
| `domain` | the name the proxy serves |
| `network_cidr` | the private network's range |
| `roles` | the machines by role: `app`, `runner`, `data`, `script`, `ldap`, each with a `count`, a `size` class and whether it is `public` |
| `ssh_public_key` | the operator's public key |
| `ssh_allowed_cidrs` | who may reach SSH |

| Output | |
| --- | --- |
| `instances` | every machine by role, with the address another machine in this environment reaches it on |
| `public_address` | what DNS points at; empty when no role is public |
| `ssh_user` | the account the key opens, which the provider decides |

Inputs **with defaults** are the provider's business and may differ: `region`, `image`,
and — on STACKIT — `project_id`.

`size` is a class, never a flavour. An environment says `medium`; the implementation
knows what that is here. An environment that named `g6-standard-2` would only be
readable by one cloud, and that is the whole of the portability argument.

## The five

| | sizes (small / medium / large) | the account model's quirk |
| --- | --- | --- |
| `linode` | `g6-nanode-1` / `g6-standard-2` / `g6-standard-4` | the private address reported is Linode's own private network, not the VPC subnet |
| `aws` | `t3.small` / `t3.medium` / `t3.large` | an internet gateway rather than a NAT gateway: every machine can reach out, and only the proxy is reachable in |
| `gcp` | `e2-small` / `e2-medium` / `e2-standard-2` | the zone is the region's first (`europe-west3` → `europe-west3-a`) |
| `azure` | `Standard_B1ms` / `Standard_B2s` / `Standard_D2s_v5` | `region` is Azure's *location* name; the image is `publisher:offer:sku:version` |
| `stackit` | `g2i.1` / `g2i.2` / `g2i.4` | every resource needs a `project_id`; the network takes a prefix *length* and assigns the range; an image has to be an id from the portal |

Credentials come from each provider's own environment variables or credentials file.
Nothing in this repository holds one, and nothing here reads one out of a tfvars file
that is tracked.

## What is checked, and what is not

`make deploy-check` runs `terraform validate` against each provider's real schema,
`terraform fmt -check`, `check-interface.py`, and `checks/host-prep.sh` — which renders
the cloud-init document an apply would send a machine and asserts that every file of
the deployment layer is in it. All of that runs on every pull request.

What none of it can say is that an environment comes up. **No implementation has ever
been applied**: there is no account behind any of the five, so `validate` is as far as
this goes, and it is worth being exact about what that covers — a machine type that
does not exist in a region, a quota, a missing permission and a wrong subnet would all
be found by an apply and by nothing here.
