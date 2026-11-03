# Linode. One private network per environment, the machines in it, and a firewall
# that decides what is reachable — which is the proxy and SSH, and nothing else
# (NFR-01).

provider "linode" {
  # The token comes from LINODE_TOKEN in the environment. No credential is in this
  # repository, in this implementation or in any of the other four.
}

locals {
  # One row per machine, so the resource below is written once and the environment's
  # shape comes from its tfvars rather than from a resource block per role.
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

  # What a size class means here, in Linode's units. The classes are the interface;
  # this is the provider's reading of them, and the only place a flavour name
  # appears.
  sizes = {
    small  = "g6-nanode-1"
    medium = "g6-standard-2"
    large  = "g6-standard-4"
  }

  # The names of the machines that take the public address.
  public = [for key, spec in local.instances : key if spec.public]

  tags = values(var.labels)
}

module "host_prep" {
  source = "../modules/host_prep"

  environment = var.environment
}

resource "linode_vpc" "main" {
  label  = "scriptoria-${var.environment}"
  region = var.region

  description = "The environment's private network. The proxy holds the only public address; everything else is reachable only from inside here."
}

resource "linode_vpc_subnet" "main" {
  vpc_id = linode_vpc.main.id
  label  = "scriptoria-${var.environment}"
  ipv4   = var.network_cidr
}

resource "linode_instance" "this" {
  for_each = local.instances

  label  = each.value.name
  region = var.region
  type   = local.sizes[each.value.size]
  image  = var.image
  tags   = local.tags

  # The operator's key, injected rather than created: the machine it opens is one of
  # these.
  authorized_keys = [var.ssh_public_key]

  # cloud-init. The runtime and the deployment layer, and not one service started —
  # the addresses a service needs are the outputs of this apply, so they cannot be
  # its inputs.
  metadata {
    user_data = base64encode(module.host_prep.user_data)
  }

  # In the environment's network. This is the address another machine in the
  # environment uses to reach it, and the one the outputs report.
  interface {
    purpose   = "vpc"
    subnet_id = linode_vpc_subnet.main.id
  }

  # The public interface an operator reaches over SSH. What is reachable on it is
  # the firewall's decision, and the firewall drops everything the rules below do
  # not name.
  interface {
    purpose = "public"
    primary = true
  }
}

# Every machine: SSH from the operator, and nothing else.
resource "linode_firewall" "internal" {
  label           = "scriptoria-${var.environment}"
  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"

  linodes = [for key, spec in local.instances : linode_instance.this[key].id]

  inbound {
    label    = "ssh"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "22"
    ipv4     = var.ssh_allowed_cidrs
  }

  inbound {
    label    = "icmp"
    action   = "ACCEPT"
    protocol = "ICMP"
    ipv4     = var.ssh_allowed_cidrs
  }
}

# The machine running the proxy: the same, plus the two ports a browser needs. This
# is the only place in the deployment where a port is open to the world.
resource "linode_firewall" "public" {
  count = length(local.public) > 0 ? 1 : 0

  label           = "scriptoria-${var.environment}-public"
  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"

  linodes = [for key in local.public : linode_instance.this[key].id]

  inbound {
    label    = "ssh"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "22"
    ipv4     = var.ssh_allowed_cidrs
  }

  inbound {
    label    = "http"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "80"
    ipv4     = ["0.0.0.0/0"]
    ipv6     = ["::/0"]
  }

  inbound {
    label    = "https"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "443"
    ipv4     = ["0.0.0.0/0"]
    ipv6     = ["::/0"]
  }

  inbound {
    label    = "icmp"
    action   = "ACCEPT"
    protocol = "ICMP"
    ipv4     = var.ssh_allowed_cidrs
  }
}
