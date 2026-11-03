# Staging: five machines, the same five as production, from the same
# implementations and at the same module versions. That sameness is the point —
# staging is worth having only while it is shaped like production, and a module
# that takes a different path per environment stops proving anything
# (docs/architecture/workspace.dsl, deployment view "Staging").

environment  = "staging"
domain       = "staging.scriptoria.example"
network_cidr = "10.20.0.0/24"

roles = {
  # The proxy, the frontend and two control-plane processes. The proxy is here
  # because it is the only machine with a public address, and it holds no
  # application of its own.
  app = { count = 1, size = "medium", public = true }
  # Its own machine: the only component holding SSH keys, and the only one that
  # reaches the script VM. Two processes, so a dead one is visible.
  runner = { count = 1, size = "medium" }
  # PostgreSQL and Redis. On their own machine here so that a run's writes and the
  # audit trail behind them do not share a disk with anything that can be restarted
  # under load.
  data = { count = 1, size = "medium" }
  # A real script VM with real scripts on it — the one thing the fixture cannot
  # stand in for (O-6).
  script = { count = 1, size = "small" }
  # OpenLDAP, authoritative for every account and group (NFR-03, NFR-04).
  ldap = { count = 1, size = "small" }
}
