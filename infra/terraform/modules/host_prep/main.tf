# The host-prep document, rendered once and passed by every provider
# implementation.
#
# It is a module rather than a copy per provider because "the deployment runs on
# any of these" has to be a fact about one file. The five implementations differ in
# how they create machines; they do not differ in what a machine needs to become a
# Scriptoria host, and a second copy of this document would be the first place the
# two drifted.
#
# The files come from infra/deploy — the same units, the same proxy configuration,
# the same scripts an operator runs by hand. A host prepared by an apply and a host
# prepared by an operator are therefore the same host.

variable "environment" {
  description = "Named in the document's closing message, so a machine's console says which environment it belongs to."
  type        = string
}

locals {
  deploy = "${path.module}/../../../deploy"

  # Every file of the deployment layer, keyed by where it lands under
  # /opt/scriptoria/deploy. Found rather than listed: a file added to
  # infra/deploy and not named here would be a file that exists on a checkout and
  # not on a host.
  files = merge(
    { for f in fileset("${local.deploy}/nginx", "**") : "nginx/${f}" => "${local.deploy}/nginx/${f}" },
    { for f in fileset("${local.deploy}/systemd", "**") : "systemd/${f}" => "${local.deploy}/systemd/${f}" },
    { for f in fileset("${local.deploy}/scripts", "**") : "scripts/${f}" => "${local.deploy}/scripts/${f}" },
    { "app.env.example" = "${local.deploy}/app.env.example" },
  )
}

output "user_data" {
  description = "The cloud-init document, ready to hand to any provider that takes one."
  value = templatefile("${path.module}/../../cloud-init/host.yaml.tftpl", {
    environment = var.environment
    files = {
      for target, source in local.files : target => {
        # base64 rather than a YAML block scalar: these files contain colons,
        # quotes and indentation that a block scalar would rewrite, and a rewritten
        # nginx.conf is a proxy that does not start.
        content = base64encode(file(source))
        mode    = endswith(source, ".sh") ? "0755" : "0644"
      }
    }
  })
}
