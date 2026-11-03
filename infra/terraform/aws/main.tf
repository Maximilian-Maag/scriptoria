provider "aws" {
  # Credentials come from the environment — AWS_ACCESS_KEY_ID and
  # AWS_SECRET_ACCESS_KEY, a profile, or an instance role. No credential is in this
  # repository, in this implementation or in any of the other four.
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

  # What a size class means here, in EC2's units.
  sizes = {
    small  = "t3.small"
    medium = "t3.medium"
    large  = "t3.large"
  }

  public = [for key, spec in local.instances : key if spec.public]

  tags = merge(var.labels, {
    environment = var.environment
    managed-by  = "scriptoria"
  })
}

module "host_prep" {
  source = "../modules/host_prep"

  environment = var.environment
}

# Ubuntu 24.04, looked up rather than pinned: an AMI id belongs to a region, and a
# repository that pinned one would only be applicable in that region.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = var.network_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = "scriptoria-${var.environment}" })
}

resource "aws_subnet" "main" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.network_cidr
  availability_zone = data.aws_availability_zones.available.names[0]

  tags = merge(local.tags, { Name = "scriptoria-${var.environment}" })
}

# A way out, and a NAT gateway's job done by an internet gateway instead: the
# machines install packages when they are first created and the script VM reaches
# its targets (NFR-06), while what is *reachable* is the security groups' decision.
# A NAT gateway would be the tidier way to keep the internal machines off the
# public internet and it costs more than this deployment's entire compute.
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.tags, { Name = "scriptoria-${var.environment}" })
}

resource "aws_route_table" "main" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(local.tags, { Name = "scriptoria-${var.environment}" })
}

resource "aws_route_table_association" "main" {
  subnet_id      = aws_subnet.main.id
  route_table_id = aws_route_table.main.id
}

resource "aws_key_pair" "this" {
  key_name   = "scriptoria-${var.environment}"
  public_key = var.ssh_public_key

  tags = local.tags
}

# Every machine: SSH from the operator, and the environment's own range. Nothing
# else comes in.
resource "aws_security_group" "internal" {
  name        = "scriptoria-${var.environment}"
  description = "Scriptoria ${var.environment}: SSH from the operator, the environment's own traffic, nothing else in."
  vpc_id      = aws_vpc.main.id

  tags = local.tags

  ingress {
    description = "SSH from the operator"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_cidrs
  }

  ingress {
    description = "Everything, but only from inside the environment"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.network_cidr]
  }

  # The way out, for the packages a machine installs on its first boot and for the
  # systems a script reaches with its own credentials (NFR-06).
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# The machine running the proxy: the same, plus the two ports a browser needs. The
# only place in the deployment where a port is open to the world.
resource "aws_security_group" "public" {
  count = length(local.public) > 0 ? 1 : 0

  name        = "scriptoria-${var.environment}-public"
  description = "Scriptoria ${var.environment}: the proxy's two ports."
  vpc_id      = aws_vpc.main.id

  tags = local.tags

  ingress {
    description = "HTTP, for the redirect to HTTPS"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "this" {
  for_each = local.instances

  ami           = var.image != "" ? var.image : data.aws_ami.ubuntu.id
  instance_type = local.sizes[each.value.size]
  subnet_id     = aws_subnet.main.id
  key_name      = aws_key_pair.this.key_name

  vpc_security_group_ids = concat(
    [aws_security_group.internal.id],
    each.value.public ? [aws_security_group.public[0].id] : [],
  )

  # cloud-init. The runtime and the deployment layer, and not one service started —
  # the addresses a service needs are the outputs of this apply, so they cannot be
  # its inputs.
  user_data                   = module.host_prep.user_data
  user_data_replace_on_change = true

  # A way out as well as a way in. NFR-01's claim is about what is *reachable*, and
  # every machine installs its packages on first boot while the script VM reaches its
  # own targets (NFR-06). A NAT gateway would be the tidier way to keep the internal
  # machines off the public internet and it costs more per month than this deployment's
  # whole compute; the security groups above are what decide reachability instead.
  associate_public_ip_address = true

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  tags = merge(local.tags, { Name = each.value.name, role = each.value.role })
}

# A fixed address for the environment's DNS record. Without one, a replaced machine
# is a record that has to be found and changed by hand.
resource "aws_eip" "public" {
  count = length(local.public) > 0 ? 1 : 0

  instance = aws_instance.this[local.public[0]].id
  domain   = "vpc"

  tags = merge(local.tags, { Name = "scriptoria-${var.environment}" })
}
