provider "azurerm" {
  # Credentials and subscription come from the environment — ARM_CLIENT_ID,
  # ARM_CLIENT_SECRET, ARM_SUBSCRIPTION_ID, ARM_TENANT_ID. No credential is in this
  # repository, in this implementation or in any of the other four.
  features {}
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

  # What a size class means here, in Azure's units.
  sizes = {
    small  = "Standard_B1ms"
    medium = "Standard_B2s"
    large  = "Standard_D2s_v5"
  }

  # Azure decides it, and the deployment layer follows.
  ssh_user = "azureuser"

  # Empty means Canonical's Ubuntu 24.04. Otherwise publisher:offer:sku:version,
  # which is how Azure names an image.
  image_parts = var.image == "" ? ["Canonical", "ubuntu-24_04-lts", "server", "latest"] : split(":", var.image)

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

# Azure groups everything under a resource group before it can create any of it.
resource "azurerm_resource_group" "main" {
  name     = "scriptoria-${var.environment}"
  location = var.region
  tags     = local.tags
}

resource "azurerm_virtual_network" "main" {
  name                = "scriptoria-${var.environment}"
  address_space       = [var.network_cidr]
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_subnet" "main" {
  name                 = "scriptoria-${var.environment}"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.network_cidr]
}

# Every machine: SSH from the operator, and the environment's own traffic.
resource "azurerm_network_security_group" "internal" {
  name                = "scriptoria-${var.environment}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags

  security_rule {
    name                       = "ssh"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefixes    = var.ssh_allowed_cidrs
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "within-the-environment"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = var.network_cidr
    destination_address_prefix = "*"
  }
}

# The machine running the proxy: the same, plus the two ports a browser needs. The
# only place in the deployment where a port is open to the world.
resource "azurerm_network_security_group" "public" {
  count = length(local.public) > 0 ? 1 : 0

  name                = "scriptoria-${var.environment}-public"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags

  security_rule {
    name                       = "ssh"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefixes    = var.ssh_allowed_cidrs
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "http"
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "https"
    priority                   = 130
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

# A fixed address for the environment's DNS record. Azure charges for one that is
# not attached, and an unattached one is a leak.
resource "azurerm_public_ip" "public" {
  count = length(local.public) > 0 ? 1 : 0

  name                = "scriptoria-${var.environment}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_network_interface" "this" {
  for_each = local.instances

  name                = "${each.value.name}-nic"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.main.id
    private_ip_address_allocation = "Dynamic"

    # The external address, on the one role that holds it.
    public_ip_address_id = each.value.public ? azurerm_public_ip.public[0].id : null
  }
}

resource "azurerm_network_interface_security_group_association" "this" {
  for_each = local.instances

  network_interface_id = azurerm_network_interface.this[each.key].id

  network_security_group_id = each.value.public ? azurerm_network_security_group.public[0].id : azurerm_network_security_group.internal.id
}

resource "azurerm_linux_virtual_machine" "this" {
  for_each = local.instances

  name                = each.value.name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  size                = local.sizes[each.value.size]
  admin_username      = local.ssh_user

  network_interface_ids = [azurerm_network_interface.this[each.key].id]

  tags = merge(local.tags, { role = each.value.role })

  admin_ssh_key {
    username   = local.ssh_user
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 20
  }

  source_image_reference {
    publisher = local.image_parts[0]
    offer     = local.image_parts[1]
    sku       = local.image_parts[2]
    version   = local.image_parts[3]
  }

  # cloud-init. The runtime and the deployment layer, and not one service started —
  # the addresses a service needs are the outputs of this apply, so they cannot be
  # its inputs. Azure takes custom_data base64-encoded, which is also how the
  # document is carried here.
  custom_data = base64encode(module.host_prep.user_data)
}
