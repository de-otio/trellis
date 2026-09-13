#!/usr/bin/env bash
# Vendored from de-otio/dot-work devcontainer/base at 7615bc703f6fa7bda32b8cc0d49f6f8ac0df6121 on 2026-09-13; do not edit here, edit the base and re-vendor.
# =============================================================================
# Agent sandbox egress firewall — default DROP + a resolved-IP allowlist.
# Runs once, as root, from the image ENTRYPOINT, before any agent process.
# =============================================================================
#
# READ THIS BEFORE TRUSTING IT.
#
# `devcontainer.json` has no key that filters egress. Nothing in a JSON file
# stops a container reaching sts.amazonaws.com. THIS script is the mechanism;
# the allowlist below is its input; `runArgs: --cap-add=NET_ADMIN` is what lets
# it run. If any of those three is missing, there is no egress boundary at all
# and the JSON's tidy allowlist comment is decoration.
#
# WHAT IT ACTUALLY ENFORCES, stated honestly:
#
#   * Real: default-deny at the packet layer. Anything not resolved from the
#     allowlist at container start is unreachable, including both cloud control
#     planes and the host's own services.
#   * Coarse: the allowlist is DOMAINS, the rules are IP ADDRESSES. Several
#     allowed domains sit behind shared CDNs, so at the IP layer this admits
#     other tenants of those same CDN addresses. It stops "the agent talked to
#     AWS"; it does not stop "the agent talked to some other site hosted on the
#     same Cloudflare address as the npm registry".
#   * Refreshed, not dynamic: addresses are resolved at start and re-resolved
#     every REFRESH_SECONDS by a root-owned loop that only ever ADDS addresses,
#     and only for domains already on the list below. Measured on the first real
#     build (2026-09-06): `api.github.com` answers with a SINGLE A record and
#     rotates it across a small pool on a minutes-to-hours timescale, so a
#     resolve-once allowlist starts refusing GitHub partway through a session.
#     The remedy in that situation is "restart the container", and an operator
#     who hits it under deadline reaches for the allowlist instead — which is
#     the failure this whole file exists to prevent. The refresher removes the
#     incentive. It does NOT widen what may be reached: the domain list is still
#     the only input, and it is still resolved through the container's own
#     resolver.
#   * The rigorous upgrade, when this coarseness stops being acceptable: an
#     HTTP CONNECT proxy in a sidecar that allowlists by SNI/Host, with this
#     container given no route except to the proxy. That is a compose-level
#     change, not a change to this file. Not built. NOT VERIFIED.
#
# =============================================================================
set -euo pipefail

log() { printf '[firewall] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
command -v iptables >/dev/null 2>&1 || die "iptables missing from the image"
command -v ipset    >/dev/null 2>&1 || die "ipset missing from the image"

# -----------------------------------------------------------------------------
# THE ALLOWLIST. One line per destination, each with the reason it is here.
# Adding a line is a change to what every agent in the org can reach: it goes
# through a PR with the same review as any other control-plane change, and
# `/.devcontainer/**` is CODEOWNERS-owned for exactly this reason (plan D3).
# -----------------------------------------------------------------------------
ALLOW_DOMAINS=(
  # --- GitHub: the whole point of the container ------------------------------
  github.com                      # git fetch/push over HTTPS
  api.github.com                  # gh CLI, the work-graph interface
  codeload.github.com             # tarball/zip fetch used by git and by npm git deps
  objects.githubusercontent.com   # release assets and LFS objects
  raw.githubusercontent.com       # raw file fetch; gh and tooling both use it
  ghcr.io                         # the org's own container registry (image refs in docs)

  # --- npm: `npm ci` is the entire postCreateCommand -------------------------
  registry.npmjs.org

  # --- BYO AI vendor endpoints ----------------------------------------------
  # BYO-account mode means the developer brings their own agent CLI, on their
  # own personal subscription. The container has to be able to reach whichever
  # one they use, or the mode does not work. Note what this means: prompts and
  # file contents leave the container to a third party by design. That is a
  # data-governance fact handled by process/byo-ai-policy.md (the reach rule),
  # not something this firewall can or should prevent.
  api.anthropic.com                    # Claude Code
  api.openai.com                       # Codex / OpenAI CLIs
  generativelanguage.googleapis.com    # Gemini CLI

  # Auxiliary hosts some vendor CLIs need (telemetry, auth refresh, feature
  # flags) are DELIBERATELY ABSENT. Discover them from a real failure on first
  # run and add them individually with a reason, rather than pre-allowing a
  # wildcard nobody has justified. UNVERIFIED: which, if any, are required.
)

# -----------------------------------------------------------------------------
# EXPLICITLY NOT ALLOWED. Default-deny already covers these; they are named so
# that a future widening has to delete a line that says why it exists.
# -----------------------------------------------------------------------------
#   *.amazonaws.com, sts.amazonaws.com   — the AWS control plane. Reaching it is
#                                          the thing this container prevents.
#   api.scaleway.com, *.scw.cloud        — the Scaleway control plane, same.
#   169.254.169.254                      — cloud instance metadata. Blocked
#                                          explicitly below, above every allow
#                                          rule, because a metadata endpoint is
#                                          a credential endpoint.
#   host.docker.internal:11434           — ollama on the host, i.e. doc-search.
#                                          This is the B4c decision: doc-search
#                                          is HOST-ONLY, and the hole is not
#                                          punched. See devcontainer/README.md.
#   the container's default gateway      — blocked below, which is what makes
#                                          the line above true rather than
#                                          merely intended.

# -----------------------------------------------------------------------------
# Optional intra-compose services. A repo whose tests need postgres/dynamodb/
# localstack sets AGENT_ALLOW_SERVICES="postgres:5432,dynamodb:8000,..." in its
# devcontainer.json. Each name is resolved through the compose network's DNS and
# allowed on that port only.
#
# NOT a whole-subnet allow: the host gateway usually lives in the container's
# own subnet, so "allow my subnet" would quietly re-open the host route that
# the B4c decision closed.
# -----------------------------------------------------------------------------
ALLOW_SERVICES="${AGENT_ALLOW_SERVICES:-}"

IPSET_NAME=agent-allow

# --- reset -------------------------------------------------------------------
iptables -F
iptables -X 2>/dev/null || true
ipset destroy "$IPSET_NAME" 2>/dev/null || true
ipset create "$IPSET_NAME" hash:ip family inet

# --- resolve the allowlist ---------------------------------------------------
resolved_total=0
for domain in "${ALLOW_DOMAINS[@]}"; do
  # `getent ahostsv4` uses the container's configured resolver, which on a
  # compose network is Docker's embedded DNS.
  ips="$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  if [ -z "$ips" ]; then
    die "could not resolve allowlisted domain '$domain' — refusing to start with a partial allowlist"
  fi
  for ip in $ips; do
    ipset add "$IPSET_NAME" "$ip" 2>/dev/null || true
    resolved_total=$((resolved_total + 1))
  done
  log "allow $domain -> $(echo "$ips" | tr '\n' ' ')"
done
[ "$resolved_total" -gt 0 ] || die "empty allowlist after resolution"

# --- baseline ----------------------------------------------------------------
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# --- metadata and the host, before anything is allowed -----------------------
# Link-local covers 169.254.169.254 (instance metadata) and, on some Docker
# setups, host-reachable addresses.
iptables -A OUTPUT -d 169.254.0.0/16 -j REJECT --reject-with icmp-port-unreachable

# The default gateway is how a container reaches the host (host.docker.internal
# resolves to it or to a sibling address on Docker Desktop). Blocking it is the
# enforcement behind the B4c decision. DNS to the gateway, if the resolver lives
# there, is allowed by the resolver rules below — which are port 53 only.
GATEWAY="$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')"
if [ -n "${GATEWAY:-}" ]; then
  iptables -A OUTPUT -d "$GATEWAY" -p tcp -j REJECT --reject-with icmp-port-unreachable
  log "host gateway $GATEWAY blocked for TCP (B4c: doc-search/ollama stays host-only)"
else
  log "WARNING: no default gateway found; host-route block not installed"
fi

# --- DNS ---------------------------------------------------------------------
# Only to the resolvers the container was given, only on port 53. Resolution is
# not exfiltration-proof (DNS tunnelling exists); it is allowed because nothing
# in this container works without it, and it is bounded to the resolver.
while read -r _ ns _; do
  [ -n "${ns:-}" ] || continue
  iptables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
  log "allow DNS -> $ns"
done < <(awk '/^nameserver/ {print "nameserver", $2, ""}' /etc/resolv.conf)

# --- intra-compose services --------------------------------------------------
if [ -n "$ALLOW_SERVICES" ]; then
  IFS=',' read -r -a svc_entries <<< "$ALLOW_SERVICES"
  for entry in "${svc_entries[@]}"; do
    svc="${entry%%:*}"; port="${entry##*:}"
    [ -n "$svc" ] && [ -n "$port" ] || die "malformed AGENT_ALLOW_SERVICES entry '$entry' (want name:port)"
    svc_ips="$(getent ahostsv4 "$svc" 2>/dev/null | awk '{print $1}' | sort -u || true)"
    [ -n "$svc_ips" ] || die "AGENT_ALLOW_SERVICES names '$svc', which does not resolve on this network"
    for ip in $svc_ips; do
      [ "$ip" = "${GATEWAY:-}" ] && die "service '$svc' resolves to the host gateway — refusing"
      iptables -A OUTPUT -d "$ip" -p tcp --dport "$port" -j ACCEPT
      log "allow service $svc:$port -> $ip"
    done
  done
fi

# --- the allowlist -----------------------------------------------------------
iptables -A OUTPUT -m set --match-set "$IPSET_NAME" dst -p tcp -j ACCEPT

# --- default deny ------------------------------------------------------------
iptables -P INPUT   DROP
iptables -P FORWARD DROP
iptables -P OUTPUT  DROP

# -----------------------------------------------------------------------------
# Post-conditions. A firewall that installed rules but does not actually block
# is the same class of failure as a marker scanner that scanned nothing: green,
# and meaningless. Both directions are checked, and either failure stops the
# container from starting.
# -----------------------------------------------------------------------------
if curl --silent --max-time 8 --output /dev/null https://api.github.com/zen; then
  log "post-condition OK: api.github.com reachable"
else
  die "post-condition FAILED: api.github.com is not reachable — the allowlist is broken, not tight"
fi

if curl --silent --max-time 5 --output /dev/null https://sts.amazonaws.com/ 2>/dev/null; then
  die "post-condition FAILED: sts.amazonaws.com is reachable — there is no egress boundary"
else
  log "post-condition OK: sts.amazonaws.com unreachable"
fi

log "egress boundary installed ($(ipset list "$IPSET_NAME" | grep -c '^[0-9]' || echo '?') addresses allowed)"

# -----------------------------------------------------------------------------
# The refresher. Root-owned, started here, outlives this script.
# -----------------------------------------------------------------------------
# WHAT IT DOES: every REFRESH_SECONDS, re-resolve ALLOW_DOMAINS and `ipset add`
# anything new. Nothing else. It reads the same hard-coded domain list, it only
# adds, and it never touches an iptables rule.
#
# WHY IT IS NOT A WIDENING. The set of things reachable from this container is
# defined by ALLOW_DOMAINS, which is baked into this root-owned file inside the
# image. The refresher cannot add a domain; it can only keep up with the
# addresses the domains already resolve to. If anything, it makes the allowlist
# MORE faithful to what the list says, because a stale pinned address is an
# allowlist that no longer matches its own definition.
#
# WHY IT EXISTS: measured, not theorised. `api.github.com` serves one A record
# and rotates it. A resolve-once container starts refusing GitHub partway
# through a session, with "restart the container" as the documented remedy — and
# an operator who hits that under deadline edits the allowlist instead. See the
# header.
#
# THE COST, stated: the set only grows, so a very long-lived container
# accumulates every address each CDN has handed out. That is bounded by the
# providers' pools and is the deliberate trade against flapping. Restarting the
# container resets it.
#
# The agent user cannot stop this: it runs as root, and `node` has no sudo.
# 30s, not 60s: measured on the first build, a rotation left GitHub unreachable
# for the remainder of the interval. Ten DNS queries every 30s is not a cost
# worth optimising against a capability outage.
REFRESH_SECONDS="${AGENT_REFRESH_SECONDS:-30}"
if [ "$REFRESH_SECONDS" -gt 0 ] 2>/dev/null; then
  (
    while :; do
      sleep "$REFRESH_SECONDS"
      for domain in "${ALLOW_DOMAINS[@]}"; do
        for ip in $(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u); do
          # Never re-add the gateway, whatever DNS says.
          [ "$ip" = "${GATEWAY:-}" ] && continue
          ipset add "$IPSET_NAME" "$ip" 2>/dev/null || true
        done
      done
    done
  ) &
  log "allowlist refresher started (every ${REFRESH_SECONDS}s, add-only, domains unchanged)"
else
  log "allowlist refresher DISABLED (AGENT_REFRESH_SECONDS=$REFRESH_SECONDS) — addresses are pinned at start"
fi
