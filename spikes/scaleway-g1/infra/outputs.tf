# Everything harness/load-outputs.ts needs, read via `tofu output -json`.
#
# PostgreSQL connection details come from `scaleway_rdb_instance.spike`'s
# exported `load_balancer` list (get-resource-docs confirms: "A load-balancer
# endpoint will be set by default if no Private Network is [defined]" — we
# defined neither `private_network` nor `load_balancer` blocks in
# database.tf, so Scaleway attaches the default public load-balancer
# endpoint and populates this computed attribute with it).

output "postgres_host" {
  description = "Public load-balancer hostname for the spike Postgres instance."
  value       = scaleway_rdb_instance.spike.load_balancer[0].hostname
}

output "postgres_ip" {
  description = "Public load-balancer IP for the spike Postgres instance (fallback if hostname doesn't resolve yet)."
  value       = scaleway_rdb_instance.spike.load_balancer[0].ip
}

output "postgres_port" {
  description = "Public load-balancer port for the spike Postgres instance."
  value       = scaleway_rdb_instance.spike.load_balancer[0].port
}

output "postgres_database" {
  description = "Database name created for the spike."
  value       = scaleway_rdb_database.spike.name
}

output "postgres_user" {
  description = "Admin user created for the spike (scaleway_rdb_user, not the instance's initial user)."
  value       = scaleway_rdb_user.spike.name
}

output "postgres_password" {
  description = "Password shared by the instance's initial user and the spike rdb_user."
  value       = random_password.db.result
  sensitive   = true
}

output "bucket_name" {
  description = "Object Storage bucket name (includes a random suffix for collision-avoidance across repeated apply/destroy cycles)."
  value       = scaleway_object_bucket.spike.name
}

output "bucket_region" {
  description = "Region the bucket was created in."
  value       = scaleway_object_bucket.spike.region
}

output "bucket_endpoint" {
  description = "S3-compatible endpoint URL for the bucket."
  value       = scaleway_object_bucket.spike.endpoint
}

output "sqs_endpoint" {
  description = "Base SQS-compatible endpoint for the project (region-scoped, shared by both queues)."
  value       = scaleway_mnq_sqs.spike.endpoint
}

output "sqs_standard_queue_url" {
  description = "Full queue URL for the standard queue."
  value       = scaleway_mnq_sqs_queue.standard.url
}

output "sqs_fifo_queue_url" {
  description = "Full queue URL for the FIFO queue."
  value       = scaleway_mnq_sqs_queue.fifo.url
}

output "sqs_access_key" {
  description = "SQS-compatible credentials (full manage/receive/publish perms) for the harness's AWS SDK SQSClient."
  value       = scaleway_mnq_sqs_credentials.spike.access_key
  sensitive   = true
}

output "sqs_secret_key" {
  description = "SQS-compatible secret key paired with sqs_access_key."
  value       = scaleway_mnq_sqs_credentials.spike.secret_key
  sensitive   = true
}

output "container_public_endpoint" {
  description = "Public HTTPS endpoint for the spike nginx container (scheme + domain)."
  value       = scaleway_container.spike.public_endpoint
}
