# No provider and no resources: this root exists so that `terraform plan` — which
# evaluates what `validate` does not — actually renders the host-prep document, and
# the shell check beside this file can then read it back.
#
# It is here because the interesting failures in that document are invisible to
# every other check: a `file()` path that resolves on a workstation and not in the
# module, a template loop that renders an empty file list, a base64 line that comes
# out blank. None of those is a syntax error, and all of them produce a host that
# boots with no deployment layer on it.

module "host_prep" {
  source = "../../modules/host_prep"

  environment = "dev"
}

output "user_data" {
  description = "The document, as a machine would receive it."
  value       = module.host_prep.user_data
}
