# G1 feasibility spike — provider/version pins.
#
# Grounding: provider address, latest version (v2.79.0 at time of writing),
# and every resource type used in this spike were verified against the
# OpenTofu Registry MCP (`get-provider-details` / `get-resource-docs` for
# `scaleway/scaleway`) — see the dot-notes inventory doc this spike falsifies:
# doc/topics/trellis-scaleway-portability/big-bang-migration/inventory/scaleway-opentofu-coverage.md

terraform {
  required_version = ">= 1.9"

  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "~> 2.79"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # THROWAWAY SPIKE: local state only. `tofu destroy` tears everything down
  # and the state file is gitignored — there is nothing here worth
  # persisting remotely.
  #
  # The real WS-0 (org/backend bootstrap) path uses a remote backend
  # instead: `backend "s3"` pointed at a Scaleway Object Storage bucket
  # (Scaleway's S3-compatible endpoint, with `skip_credentials_validation`,
  # `skip_region_validation`, `skip_requesting_account_id = true` since
  # Scaleway has no AWS STS), PLUS OpenTofu's native state-encryption
  # feature (`encryption` block, OpenTofu >= 1.7, PBKDF2 passphrase or an
  # external KMS key method — this is an OpenTofu core feature, not a
  # Scaleway one). See the coverage inventory doc (§0) for the exact
  # backend block. That path has a bootstrap chicken-and-egg (the state
  # bucket + IAM API key must exist before `tofu init` can use them) which
  # is exactly the kind of manual first step this spike intentionally
  # avoids by staying local.
}

provider "scaleway" {
  region = "fr-par"
  zone   = "fr-par-1"

  # access_key / secret_key / project_id / organization_id are read from
  # the environment: SCW_ACCESS_KEY, SCW_SECRET_KEY, SCW_DEFAULT_PROJECT_ID,
  # SCW_DEFAULT_ORGANIZATION_ID. Never hardcode credentials here.
}
