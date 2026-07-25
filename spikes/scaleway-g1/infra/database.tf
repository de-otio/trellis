# PostgreSQL 17 + PostGIS/pg_trgm feasibility.
#
# Grounding (get-resource-docs scaleway/scaleway rdb_instance / rdb_database
# / rdb_user, 2026-07-18):
# - `node_type = "db-play2-pico"` is the smallest node type named in the
#   coverage inventory (§2.2); the resource doc's own examples use
#   "DB-DEV-S" / "db-dev-s" as the smallest *dev-tier* class — both exist,
#   we pick db-play2-pico per the prompt's stated preference. Node type
#   names are case-insensitive per Scaleway's API but we use the lowercase
#   form the doc's "Block Storage Low Latency" example uses.
# - `engine = "PostgreSQL-17"` — confirmed available per the inventory doc's
#   Open-Q 2 answer (PG17 documented, pg-version-updates.mdx as of
#   2025-09-03; do not trust the older concepts.mdx which stops at 15).
# - PostGIS is NOT a Terraform-managed resource — there is no
#   `scaleway_rdb_*extension*` resource type in the 152-resource provider
#   (confirmed via get-provider-details). It's installed with
#   `CREATE EXTENSION postgis;` over SQL, which is exactly what
#   harness/check-postgres.ts does at runtime — this is intentional, not a
#   gap in this config.
# - `disable_backup = true` per the prompt (this is a throwaway spike; the
#   coverage doc's backup_schedule_* args are for the real deployment).
# - `is_ha_cluster = false` — no HA needed for a feasibility check, and
#   changing it later would recreate the instance anyway (doc warning).
# - Password: `password` (not `password_wo`) is used deliberately —
#   `password_wo` needs OpenTofu/Terraform >= 1.11 for write-only argument
#   support; we pin `required_version >= 1.9` per the prompt, so we stay on
#   the plain `password` argument fed by `random_password`. The DOC'S OWN
#   security-best-practice note recommends `password_wo`; this is a
#   documented discrepancy we're accepting for spike simplicity — flag it
#   before reusing this pattern in the real WS-0/WS-1 config.

resource "random_password" "db" {
  length      = 20
  special     = true
  upper       = true
  lower       = true
  numeric     = true
  min_upper   = 1
  min_lower   = 1
  min_numeric = 1
  min_special = 1
  # Exclude characters that can trip up shell/URL/JDBC connection strings;
  # matches the resource doc's own suggested override_special.
  override_special = "!@#$%^&*()_+-=[]{}|;:,.<>?"
}

resource "scaleway_rdb_instance" "spike" {
  name           = "spike-g1-pg"
  node_type      = "db-play2-pico"
  engine         = "PostgreSQL-17"
  is_ha_cluster  = false
  disable_backup = true

  # The `play2` node line mandates a Block Storage volume — the default
  # `lssd` (local SSD) is rejected by the API ("Volume type can't be a local
  # volume for this node_type"), confirmed live 2026-07-19. The resource
  # doc's own "Block Storage Low Latency" example pairs db-play2-pico with
  # `sbs_15k`; we use the cheaper `sbs_5k` tier + the 10 GB the example uses.
  # G1 FINDING: the real WS-0 rdb config must set volume_type/size explicitly
  # for any play2/pro2 node type — it cannot rely on the lssd default.
  volume_type       = "sbs_5k"
  volume_size_in_gb = 10

  user_name = "spike_g1_admin"
  password  = random_password.db.result

  # Encryption at rest costs nothing extra to enable and matches the
  # baseline the real deployment would use; doesn't affect the feasibility
  # questions this spike is testing.
  encryption_at_rest = true

  # No private_network / load_balancer block => Scaleway gives the
  # instance a default public load-balancer endpoint (doc: "If nothing is
  # defined, your Database Instance will have a default public
  # load-balancer endpoint"). That's what the harness connects to — the
  # spike doesn't stand up a VPC private network, since the private-path
  # question is already answered in the coverage inventory (§2.2) and
  # isn't one of the open questions this spike needs to re-verify.
}

resource "scaleway_rdb_database" "spike" {
  instance_id = scaleway_rdb_instance.spike.id
  name        = "spike_g1_db"
}

resource "scaleway_rdb_user" "spike" {
  instance_id = scaleway_rdb_instance.spike.id
  name        = "spike_g1_user"
  password    = random_password.db.result
  is_admin    = true
}

# G1 FINDING (live 2026-07-19): a separately-created scaleway_rdb_user does
# NOT get access to a scaleway_rdb_database just because is_admin=true — the
# harness connected fine but hit "permission denied for database
# spike_g1_db". Scaleway RDB decouples user creation from per-database
# grants; you must add an explicit scaleway_rdb_privilege. The real WS-0
# rdb config needs a privilege grant per (user, database) pair.
resource "scaleway_rdb_privilege" "spike" {
  instance_id   = scaleway_rdb_instance.spike.id
  user_name     = scaleway_rdb_user.spike.name
  database_name = scaleway_rdb_database.spike.name
  permission    = "all"
}
