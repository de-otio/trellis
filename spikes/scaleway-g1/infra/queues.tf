# Messaging & Queuing (MNQ) SQS feasibility — standard queue + FIFO queue
# with content-based dedup. See harness/check-sqs.ts for the AWS-SDK-v3
# compat + ordering/dedup checks.
#
# Grounding (get-resource-docs scaleway/scaleway mnq_sqs / mnq_sqs_credentials
# / mnq_sqs_queue, 2026-07-18):
# - `scaleway_mnq_sqs` activates the SQS-compatible API for the project and
#   exports `endpoint`.
# - `scaleway_mnq_sqs_credentials` mints an access_key/secret_key pair
#   scoped by a `permissions` block (`can_manage` / `can_receive` /
#   `can_publish`). The prompt asks for "full perms" so all three are true.
# - `scaleway_mnq_sqs_queue` takes `access_key`/`secret_key` directly
#   (not implicit provider auth) plus `sqs_endpoint` — this is because the
#   queue itself is managed through the SQS-compatible API surface, not the
#   Scaleway management API. `fifo_queue = true` requires the queue `name`
#   to end in `.fifo`; `content_based_deduplication` is documented as
#   "FIFO-only" in the coverage inventory (confirmed no such restriction is
#   enforced by the resource schema itself, but we only set it on the FIFO
#   queue per that guidance).

resource "scaleway_mnq_sqs" "spike" {}

resource "scaleway_mnq_sqs_credentials" "spike" {
  project_id = scaleway_mnq_sqs.spike.project_id
  name       = "spike-g1-sqs-creds"

  permissions {
    can_manage  = true
    can_receive = true
    can_publish = true
  }
}

resource "scaleway_mnq_sqs_queue" "standard" {
  project_id   = scaleway_mnq_sqs.spike.project_id
  name         = "spike-g1-standard"
  sqs_endpoint = scaleway_mnq_sqs.spike.endpoint
  access_key   = scaleway_mnq_sqs_credentials.spike.access_key
  secret_key   = scaleway_mnq_sqs_credentials.spike.secret_key
}

resource "scaleway_mnq_sqs_queue" "fifo" {
  project_id   = scaleway_mnq_sqs.spike.project_id
  name         = "spike-g1-fifo.fifo"
  sqs_endpoint = scaleway_mnq_sqs.spike.endpoint
  access_key   = scaleway_mnq_sqs_credentials.spike.access_key
  secret_key   = scaleway_mnq_sqs_credentials.spike.secret_key

  fifo_queue                  = true
  content_based_deduplication = true
}
