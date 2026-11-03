terraform {
  required_version = ">= 1.6"

  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 4.0"
    }
  }

  # Deliberately empty. The same implementation is applied once per environment, so
  # where the state lives is a property of the apply rather than of the code:
  #
  #   terraform init -backend-config=... -reconfigure
  #
  # with the bucket, the key and the credentials supplied there. One state per
  # environment per provider, because that is the unit two operators can touch
  # without meeting.
  backend "s3" {}
}
