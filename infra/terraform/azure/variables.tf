# The interface. Every implementation declares these variables under these names,
# with these types — that is what "the deployment runs on any of these providers"
# means, and check-interface.sh fails the build when one of them drifts.
#
# Anything a provider cannot express identically is either a class (a size) or a
# value with a provider-specific default (a region, an image), and never a name the
# caller has to know. An environment's tfvars names no machine.

variable "environment" {
  description = "dev, staging or prod. Names everything, so two environments can sit in one account."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "The environments are dev, staging and prod. The architecture model's fourth view is the local stack, which is docker compose on a workstation and not this."
  }
}

variable "domain" {
  description = "The name the proxy serves, for the operator's DNS record. The apply prints the address it should point at."
  type        = string
}

variable "network_cidr" {
  description = "The private network's range, from environments/<env>.tfvars."
  type        = string
}

variable "roles" {
  description = <<-EOT
    The machines to create, by role. The names are the architecture model's: app
    (the proxy, the frontend and the control plane), runner, data (PostgreSQL and
    Redis), script (the script VM) and ldap (the directory). Which roles share a
    machine is an environment's decision, which is why dev names three and
    production five.

    `size` is a class — small, medium or large — and not a machine. What a class
    means is the implementation's business, and it is the only provider-specific
    value an environment would otherwise have had to know.
  EOT
  type = map(object({
    count  = number
    size   = string
    public = optional(bool, false)
  }))

  validation {
    condition     = alltrue([for spec in var.roles : contains(["small", "medium", "large"], spec.size)])
    error_message = "Sizes are small, medium and large."
  }

  validation {
    condition     = alltrue([for role in keys(var.roles) : contains(["app", "runner", "data", "script", "ldap"], role)])
    error_message = "Unknown role. The roles are app, runner, data, script and ldap — the deployment units are per role, so a new name here is a new unit somewhere else."
  }

  validation {
    condition     = length([for role, spec in var.roles : role if spec.public]) <= 1
    error_message = "One role holds the public address. That is NFR-01: exactly one machine is reachable from outside, and it is the one running the proxy."
  }
}

variable "ssh_public_key" {
  description = "The public half of the key the deploying operator holds. Not in the repository: a required input, from -var or an untracked tfvars file."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "Who may reach SSH on any machine. Everything else is closed (NFR-01). Required, because this repository has no opinion about who that is."
  type        = list(string)
}

variable "region" {
  description = "This provider's region name — Azure calls it a location. The default is a European region, for reasons of where the accounts and the users are; set it when that is wrong."
  type        = string
  default     = "Germany West Central"
}

variable "image" {
  description = "The base image, as publisher:offer:sku:version. Empty means Canonical's Ubuntu 24.04 — the deployment layer assumes cloud-init and systemd and nothing else."
  type        = string
  default     = ""
}

variable "labels" {
  description = "Applied to every machine, for the operator's bookkeeping."
  type        = map(string)
  default     = {}
}
