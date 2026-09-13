#!/usr/bin/env bash
# Vendored from de-otio/dot-work devcontainer/base at 7615bc703f6fa7bda32b8cc0d49f6f8ac0df6121 on 2026-09-13; do not edit here, edit the base and re-vendor.
# =============================================================================
# Agent sandbox entrypoint — runs as root, drops nothing, execs the CMD.
# =============================================================================
#
# WHY THE FIREWALL IS HERE AND NOT IN postCreateCommand.
#
# The plan requires postCreateCommand to be limited to toolchain install,
# because postCreateCommand is agent control plane: anything in it changes what
# every agent in the org may do, and it lives in a file agents can edit. The
# egress boundary must not be editable by the thing it constrains.
#
# So the firewall runs from the image ENTRYPOINT, as root, before any agent
# process exists. A repo cannot opt out of it by editing its devcontainer.json,
# and the container user (`node`, no sudo, root locked) cannot undo it.
#
# FAIL CLOSED. If the firewall cannot be installed, or its own post-conditions
# do not hold, the container does not start. A sandbox that silently came up
# without its boundary is the exact failure this file exists to prevent.
# =============================================================================
set -euo pipefail

log() { printf '[agent-sandbox] %s\n' "$*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  log "FATAL: entrypoint must run as root (set \"containerUser\": \"root\" in devcontainer.json)."
  log "       Interactive sessions still run as \`node\` via \"remoteUser\"."
  exit 1
fi

# --- egress boundary -------------------------------------------------------
if [ "${AGENT_SKIP_FIREWALL:-0}" = "1" ]; then
  # Deliberately loud, deliberately not silent, deliberately still allowed:
  # a developer debugging the firewall itself needs this, and a run that used
  # it must never be mistaken for evidence. boundary-test.sh re-checks egress
  # at test time for exactly this reason.
  log "WARNING: AGENT_SKIP_FIREWALL=1 — NO EGRESS BOUNDARY IN THIS CONTAINER."
  log "WARNING: any boundary-test.sh result from this container is void."
else
  /usr/local/sbin/init-firewall.sh
fi

# --- marker scanning (plan finding C9) -------------------------------------
# Wire repo-aegis's git hooks into the container-local core.hooksPath set in the
# image. Their content belongs to the installed repo-aegis version, so they are
# written at start rather than baked.
AEGIS_HOME="${REPO_AEGIS_HOME:-/opt/agent/repo-aegis}"
AEGIS_REGISTRY="${REPO_AEGIS_REGISTRY:-/opt/agent/registry/engagements.yaml}"

if command -v repo-aegis >/dev/null 2>&1; then
  # The registry mount is what makes the deny set engagement-scoped rather than
  # universal-only. Its absence is the recorded C9 failure mode (an empty or
  # near-empty deny set producing a green scan that checked nothing), so it is
  # warned about here and asserted hard by boundary-test.sh check 8.
  if [ -e "$AEGIS_REGISTRY" ] || [ -e "${AEGIS_REGISTRY}.age" ]; then
    # Derive the marker files into the container-local, root-owned home.
    repo-aegis render >/dev/null 2>&1 \
      || log "WARNING: \`repo-aegis render\` failed — deny set may be universal-only."
  else
    log "WARNING: no engagement registry at ${AEGIS_REGISTRY}."
    log "         Marker scanning will fall back to the universal patterns only."
    log "         boundary-test.sh check 8 will fail, which is the intended signal."
  fi

  # `install hooks` writes pre-commit/pre-push into <home>/hooks and sets a
  # global core.hooksPath. We republish them at the path the image configured
  # system-wide, so the wiring is the same for every user in the container and
  # is not something the agent's own git config can shadow.
  repo-aegis install hooks --force >/dev/null 2>&1 || true
  if [ -d "${AEGIS_HOME}/hooks" ]; then
    cp -f "${AEGIS_HOME}/hooks/"* /opt/agent/hooks/ 2>/dev/null || true
    chmod 0755 /opt/agent/hooks/* 2>/dev/null || true
  fi
  chmod -R a+rX "$AEGIS_HOME" 2>/dev/null || true
  git config --system core.hooksPath /opt/agent/hooks
else
  log "WARNING: repo-aegis is not installed — marker scanning will not run."
  log "         boundary-test.sh check 7 will fail, which is the intended signal."
fi

log "ready — egress boundary installed, running as root, sessions run as node"
exec "$@"
