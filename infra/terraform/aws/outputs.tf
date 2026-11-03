# What an operator needs after an apply, and nothing else. The shape here is the
# interface: five implementations produce these same outputs, so the step after an
# apply — read the addresses, write app.env on each host, start the units — is the
# same paragraph in docs/guides/deployment.md whoever the provider is.

output "instances" {
  description = "Every machine by role, with the address another machine in this environment reaches it on. This is what fills in /etc/scriptoria/app.env."
  value = {
    for role in sort(keys(var.roles)) : role => [
      for key, spec in local.instances : {
        name    = spec.name
        id      = aws_instance.this[key].id
        address = aws_instance.this[key].private_ip
        public  = spec.public
      } if spec.role == role
    ]
  }
}

output "public_address" {
  description = "The address the environment's DNS record points at. Empty when no role holds a public address, which is a deliberate shape in a network with no way in."
  value       = length(local.public) > 0 ? aws_eip.public[0].public_ip : ""
}

output "ssh_user" {
  description = "The account the operator's key opens. Printed because the provider decides it and the deployment layer does not."
  value       = "ubuntu"
}
