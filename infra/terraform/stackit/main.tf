provider "stackit" {
  default_region = var.region
  # Credentials come from the environment or from ~/.stackit/credentials.json —
  # STACKIT_SERVICE_ACCOUNT_KEY_PATH and STACKIT_PRIVATE_KEY_PATH. No credential is
  # in this repository, in this implementation or in any of the other four.
}

locals {
  # One row per machine, so the resource below is written once and the environment's
  # shape comes from its tfvars.
  instances = merge([
    for role, spec in var.roles : {
      for n in range(1, spec.count + 1) : "${role}-${n}" => {
        role   = role
        name   = "${var.environment}-${role}-${n}"
        size   = spec.size
        public = spec.public
      }
    }
  ]...)

  # What a size class means here, in STACKIT's units.
  sizes = {
    small  = "g2i.1"
    medium = "g2i.2"
    large  = "g2i.4"
  }

  # An environment names a region and a machine needs a zone, so the zone is the
  # region's first: "eu01" becomes "eu01-1".
  zone = "${var.region}-1"

  ssh_user = "ubuntu"

  public = [for key, spec in local.instances : key if spec.public]

  labels = merge(var.labels, {
    environment = var.environment
    managed-by  = "scriptoria"
  })
}

module "host_prep" {
  source = "../modules/host_prep"

  environment = var.environment
}

resource "stackit_key_pair" "this" {
  name       = "scriptoria-${var.environment}"
  public_key = var.ssh_public_key
}

resource "stackit_network" "main" {
  project_id = var.project_id
  name       = "scriptoria-${var.environment}"

  # STACKIT takes a prefix length and assigns the range, rather than taking the
  # range. So the environment's CIDR decides how big the network is and not which
  # addresses are in it — the one place an implementation cannot honour the
  # interface exactly, and the reason the rules below match each other by security
  # group rather than by address.
  ipv4_prefix_length = tonumber(split("/", var.network_cidr)[1])

  # Not routed: the environment's network is reachable from inside it, and
  # NFR-01 puts the only public address on the proxy.
  routed = false
}

# Every machine: SSH from the operator, and the environment's own traffic.
resource "stackit_security_group" "internal" {
  project_id = var.project_id
  name       = "scriptoria-${var.environment}"
  stateful   = true
}

resource "stackit_security_group_rule" "ssh" {
  for_each = toset(var.ssh_allowed_cidrs)

  project_id        = var.project_id
  security_group_id = stackit_security_group.internal.security_group_id
  direction         = "ingress"
  ether_type        = "IPv4"
  ip_range          = each.value
  description       = "SSH from the operator"

  protocol   = { name = "tcp" }
  port_range = { min = 22, max = 22 }
}

# The environment's own traffic, matched by membership rather than by address:
# this provider assigns the range, so the deployment does not know the addresses
# to write a rule about.
resource "stackit_security_group_rule" "internal" {
  project_id               = var.project_id
  security_group_id        = stackit_security_group.internal.security_group_id
  direction                = "ingress"
  ether_type               = "IPv4"
  remote_security_group_id = stackit_security_group.internal.security_group_id
  description              = "The environment's own traffic"
}

# The machine running the proxy: the same, plus the two ports a browser needs. The
# only place in the deployment where a port is open to the world.
resource "stackit_security_group" "public" {
  count = length(local.public) > 0 ? 1 : 0

  project_id = var.project_id
  name       = "scriptoria-${var.environment}-public"
  stateful   = true
}

resource "stackit_security_group_rule" "public" {
  for_each = length(local.public) > 0 ? { http = 80, https = 443 } : {}

  project_id        = var.project_id
  security_group_id = stackit_security_group.public[0].security_group_id
  direction         = "ingress"
  ether_type        = "IPv4"
  ip_range          = "0.0.0.0/0"
  description       = "From anywhere, on the ports a browser uses"

  protocol   = { name = "tcp" }
  port_range = { min = each.value, max = each.value }
}

resource "stackit_security_group_rule" "public_ssh" {
  for_each = length(local.public) > 0 ? toset(var.ssh_allowed_cidrs) : toset([])

  project_id        = var.project_id
  security_group_id = stackit_security_group.public[0].security_group_id
  direction         = "ingress"
  ether_type        = "IPv4"
  ip_range          = each.value
  description       = "SSH from the operator"

  protocol   = { name = "tcp" }
  port_range = { min = 22, max = 22 }
}

resource "stackit_network_interface" "this" {
  for_each = local.instances

  project_id = var.project_id
  network_id = stackit_network.main.network_id
  name       = "${each.value.name}-nic"
  labels     = local.labels

  security_group_ids = concat(
    [stackit_security_group.internal.security_group_id],
    each.value.public ? [stackit_security_group.public[0].security_group_id] : [],
  )
}

# A way out, which every machine needs to be prepared at all: its packages were not
# baked into the image, and the host-prep document installs them. What is
# *reachable* is the security groups' decision above, which is NFR-01's claim —
# a public address that nothing may open a port on is not an address that is
# reachable.
resource "stackit_public_ip" "this" {
  for_each = local.instances

  project_id           = var.project_id
  network_interface_id = stackit_network_interface.this[each.key].network_interface_id
  labels               = local.labels
}

resource "stackit_server" "this" {
  for_each = local.instances

  project_id        = var.project_id
  name              = each.value.name
  machine_type      = local.sizes[each.value.size]
  availability_zone = local.zone
  keypair_name      = stackit_key_pair.this.name
  labels            = local.labels

  network_interfaces = [stackit_network_interface.this[each.key].network_interface_id]

  # cloud-init. The runtime and the deployment layer, and not one service started —
  # the addresses a service needs are the outputs of this apply, so they cannot be
  # its inputs.
  user_data = module.host_prep.user_data

  boot_volume = {
    size        = 20
    source_type = "image"
    source_id   = var.image
  }
}
