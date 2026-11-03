provider "google" {
  # Credentials come from the environment — GOOGLE_APPLICATION_CREDENTIALS, or the
  # account the machine running this already is — and the project from
  # GOOGLE_PROJECT. No credential is in this repository, in this implementation or
  # in any of the other four.
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

  # What a size class means here, in GCP's units.
  sizes = {
    small  = "e2-small"
    medium = "e2-medium"
    large  = "e2-standard-2"
  }

  # An environment names a region and an instance needs a zone, so the zone is the
  # region's first. Not a decision an environment should have to make twice.
  zone = "${var.region}-a"

  # GCP decides it, and the deployment layer follows: every Ubuntu image here takes
  # the key for this account.
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

resource "google_compute_network" "main" {
  name                    = "scriptoria-${var.environment}"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "main" {
  name          = "scriptoria-${var.environment}"
  network       = google_compute_network.main.id
  ip_cidr_range = var.network_cidr
  region        = var.region
}

# A fixed address for the environment's DNS record. Without one, a replaced machine
# is a record that has to be found and changed by hand.
resource "google_compute_address" "public" {
  count = length(local.public) > 0 ? 1 : 0

  name         = "scriptoria-${var.environment}"
  region       = var.region
  address_type = "EXTERNAL"
}

# The rules are attached to machines by tag rather than by address, so a machine's
# role travels with it: everything is tagged with the environment, and the machine
# running the proxy carries a second tag that opens the two ports a browser needs.
resource "google_compute_firewall" "ssh" {
  name          = "scriptoria-${var.environment}-ssh"
  network       = google_compute_network.main.name
  source_ranges = var.ssh_allowed_cidrs
  target_tags   = ["scriptoria-${var.environment}"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# The environment's own traffic. GCP's default network also allows SSH and ICMP
# internally; this is the deployment's own statement of it rather than a dependency
# on a project's defaults, which are not this repository's to rely on.
resource "google_compute_firewall" "internal" {
  name          = "scriptoria-${var.environment}-internal"
  network       = google_compute_network.main.name
  source_ranges = [var.network_cidr]
  target_tags   = ["scriptoria-${var.environment}"]

  allow {
    protocol = "tcp"
  }

  allow {
    protocol = "udp"
  }

  allow {
    protocol = "icmp"
  }
}

# The machine running the proxy: the only place in the deployment where a port is
# open to the world.
resource "google_compute_firewall" "public" {
  count = length(local.public) > 0 ? 1 : 0

  name          = "scriptoria-${var.environment}-public"
  network       = google_compute_network.main.name
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["scriptoria-${var.environment}-public"]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

resource "google_compute_instance" "this" {
  for_each = local.instances

  name         = each.value.name
  machine_type = local.sizes[each.value.size]
  zone         = local.zone
  labels       = local.labels

  tags = concat(
    ["scriptoria-${var.environment}"],
    each.value.public ? ["scriptoria-${var.environment}-public"] : [],
  )

  boot_disk {
    initialize_params {
      image = var.image
      size  = 20
    }
  }

  # Changing a machine's size is a stop-and-start, and an apply that refused to do
  # it would leave an operator resizing by hand at the moment they are least
  # inclined to.
  allow_stopping_for_update = true

  network_interface {
    subnetwork = google_compute_subnetwork.main.id

    # A way out as well as a way in. NFR-01's claim is about what is *reachable*, and
    # every machine installs its packages on first boot while the script VM reaches its
    # own targets (NFR-06) — neither of which is possible without an address to leave
    # by. The public role gets the environment's fixed address; every other machine gets
    # an ephemeral one, and the firewall above is what decides what may reach it.
    #
    # Cloud NAT would be the tidier arrangement and is another component with its own
    # cost; it is worth revisiting when the machines no longer install anything at boot.
    dynamic "access_config" {
      for_each = [1]

      content {
        nat_ip = each.value.public ? google_compute_address.public[0].address : null
      }
    }
  }

  metadata = {
    # cloud-init. The runtime and the deployment layer, and not one service started.
    user-data = module.host_prep.user_data

    # The account the operator's key opens.
    ssh-keys = "${local.ssh_user}:${var.ssh_public_key}"
  }
}
