# Production: the same five machines as staging, larger, with three control-plane
# processes instead of two.

environment  = "prod"
domain       = "scriptoria.example"
network_cidr = "10.30.0.0/24"

roles = {
  app    = { count = 1, size = "large", public = true }
  runner = { count = 1, size = "medium" }
  # Backed up on a timer. The audit trail lives here and is the one thing that
  # cannot be rebuilt.
  data = { count = 1, size = "large" }
  # One instance is the normal case; more are possible (NFR-07). Nothing is
  # installed here and no port is opened to the internet.
  script = { count = 1, size = "small" }
  ldap   = { count = 1, size = "small" }
}
