# Serverless Containers feasibility — scale-to-zero + cold-start latency.
# See harness/check-container.ts for the HTTP GET + cold/warm latency probe.
#
# Grounding (get-resource-docs scaleway/scaleway container_namespace /
# container, 2026-07-18):
# - `image` takes a plain registry address; the resource doc's own "Basic"
#   example uses `image = "nginx:latest"` directly (a public Docker Hub
#   image, no `rg.fr-par.scw.cloud/...` prefix needed) — confirms public
#   Docker Hub images are pulled straight through. We reuse that exact
#   image since nginx's default page returns 200 with no config, making it
#   the simplest "hello-world-ish" HTTP target for the cold/warm-start
#   check.
# - `min_scale = 0` / `max_scale = 1` are the prompt's requested bounds.
#   The doc's scale-to-zero caveat ("when cpu_usage_threshold or
#   memory_usage_threshold are used, min_scale can't be 0") only applies if
#   a `scaling_option` block is set — we don't set one here, so scale-to-zero
#   is unconstrained.
# - Memory/vCPU are coupled per the doc's table; the smallest documented
#   pair is 128 MB memory / 70m vCPU. `memory_limit_bytes` takes bytes, so
#   128 MB = 128 * 1024 * 1024 = 134217728 bytes.
# - `privacy = "public"` is the prompt's requirement (and also the
#   resource's documented default, stated explicitly here for clarity).
# - `port = 80` matches nginx's default listen port.

resource "scaleway_container_namespace" "spike" {
  name        = "spike-g1-containers"
  description = "G1 feasibility spike — serverless container namespace"
}

resource "scaleway_container" "spike" {
  name         = "spike-g1-hello"
  description  = "G1 feasibility spike — nginx hello-world for cold-start + reachability checks"
  namespace_id = scaleway_container_namespace.spike.id

  image = "nginx:latest"
  port  = 80

  cpu_limit          = 70
  memory_limit_bytes = 134217728 # 128 MiB, the smallest documented cpu/memory pairing
  min_scale          = 0
  max_scale          = 1
  privacy            = "public"
  protocol           = "http1"
}
