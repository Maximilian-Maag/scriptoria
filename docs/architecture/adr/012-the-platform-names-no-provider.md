# ADR-012 — The platform names no provider

**Status:** Accepted
**Context:** NFR-01, NFR-07, the Portability view of `workspace.dsl`

## Context

The deployment model was written against Linode: the environments, the portability view, the README's
environment table and the NFRs all say so, and the module set was designed as "one provider
implemented, the others beside it so the interface stays honest".

That last part was always the weak point, and it stopped being a theoretical one: there is no Linode
account any more. An environment now has to be buildable on Linode, AWS, GCP, Azure or STACKIT, and
none of them is the obvious default.

## Decision

The hosts are created by five implementations behind one interface, and no provider is named
anywhere in the platform.

**What is provider-specific is as small as it can be.** An instance, membership in a private network,
a firewall, and one public address. That is all the substrate Terraform has to produce, because the
runtime above it is identical everywhere: Linux, systemd, rootless podman and nginx, which
`infra/deploy` installs the same way on any of them.

**The contract is a set of required inputs and outputs, and it is checked.** Six required variables
(`environment`, `domain`, `network_cidr`, `roles`, `ssh_public_key`, `ssh_allowed_cidrs`), three
outputs (`instances`, `public_address`, `ssh_user`), and three size classes. `check-interface.py`
fails the build when one implementation drifts, which is the difference between five implementations
of a contract and five implementations that happen to look alike today.

**Sizes are classes, never flavours.** An environment says `medium`. If it said `g6-standard-2`, it
would be readable by one cloud, and portability would be a claim about a repository nobody had read
carefully.

**Nothing above the substrate is provider-specific.** PostgreSQL and Redis run as the same containers
on the data instance rather than as each provider's managed store, and the proxy holds the public
address rather than sitting behind a managed balancer. A managed store and a managed balancer per
provider are five integrations each, and the model's own note called the data module "where the
portability claim is thinnest" — that thinness is exactly what removes it.

**A provider may differ where it must, and says so.** STACKIT has no image by name and takes a
network's prefix *length* rather than its range; Azure calls its region a location; GCP needs a zone
where an environment names a region; Linode's private address is its own private network rather than
the VPC's subnet. Each is written down in its implementation and in `infra/terraform/README.md`
rather than smoothed over, because a difference that is hidden is a difference that is found on the
first apply.

## Why not the alternatives

**Keep Linode as the only implementation.** It cannot be built: there is no account, and the
interface-with-one-implementation objection was already in the model.

**Managed services where a provider has them** (RDS, Cloud SQL, Azure Database, Managed LDAP,
NodeBalancer/ALB/Application Gateway). It looks like the mature choice — let the provider run the
database — and it would make each environment a different system: five backup mechanisms, five
connection-surfacing stories, five failover behaviours. None of it could be verified here, and the
platform already has a backup unit with a timer and a restore path that is the same everywhere.

**Kubernetes as the portable layer** (EKS, GKE, AKS, SKE). One substrate that really is the same
everywhere, at the cost of a control plane, an ingress controller, a storage class and a new set of
failure modes — for three machines. It becomes the right answer at a scale this deployment does not
have, and the interface is what makes it reachable later: a `k8s` implementation would satisfy the
same contract.

**Five provider stacks without a shared contract.** Drift is then invisible until the first
environment is built on a provider nobody tried, which is the failure this ADR exists to avoid.

## Consequences

Five implementations to maintain instead of one. Each is deliberately thin — machines, network,
firewall, one address — and the contract check makes the cost of keeping them the same visible in the
build rather than in an incident.

**None of the five has been applied.** There is no account behind any of them, so what is verified is
that each validates against its provider's real schema, that the five still declare one contract, and
that the cloud-init document a machine would receive carries the whole deployment layer. What an
apply would additionally prove — machine types available in a region, quotas, permissions, subnet
correctness — is unproven, and `infra/terraform/README.md` says so in as many words.

The first real apply is still where the surprises are. The difference is where they will be found: in
one implementation's reading of its provider, rather than in an assumption that was never written
down because there was only ever one provider to write it for.
