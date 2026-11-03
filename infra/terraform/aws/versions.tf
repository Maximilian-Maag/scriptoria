terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
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
