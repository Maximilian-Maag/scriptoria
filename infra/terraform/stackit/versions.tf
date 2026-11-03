terraform {
  required_version = ">= 1.6"

  required_providers {
    stackit = {
      source  = "stackitcloud/stackit"
      version = "~> 0.50"
    }
  }

  # Deliberately empty. The same implementation is applied once per environment, so
  # where the state lives is a property of the apply rather than of the code:
  #
  #   terraform init -backend-config=... -reconfigure
  #
  # with the bucket, the key and the credentials supplied there.
  backend "s3" {}
}
