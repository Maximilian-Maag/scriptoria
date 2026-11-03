# Dev: three machines. One carries the proxy, the frontend, the control plane, both
# stores and the directory together — everything that is separate in production,
# together, because dev buys a place to run the thing rather than evidence about
# how it behaves under load (docs/architecture/workspace.dsl, deployment view
# "Dev").
#
# This file is the same shape for all five providers. What changes between them is
# which machine a "medium" is, and that belongs to the implementation rather than
# here: an environment that named a flavour by name would only be readable by one
# cloud.

environment  = "dev"
domain       = "dev.scriptoria.example"
network_cidr = "10.10.0.0/24"

roles = {
  # The proxy, the frontend, the control plane, PostgreSQL, Redis and the
  # directory on one machine. Everything that is separate in production, together.
  app = { count = 1, size = "small", public = true }
  # Its own machine even here: it is the only thing holding SSH keys and the only
  # thing that reaches the script VM. Collapsing it would make dev the one
  # environment where that boundary does not exist.
  runner = { count = 1, size = "small" }
  # The script VM: provisioned, then left alone. The platform installs nothing on
  # it (NFR-07), so "the deployment" here means making the machine exist.
  script = { count = 1, size = "small" }
}
