# syntax=docker/dockerfile:1
# Vendored from de-otio/dot-work devcontainer/base at 7615bc703f6fa7bda32b8cc0d49f6f8ac0df6121 on 2026-09-13; do not edit here, edit the base and re-vendor.
# =============================================================================
# De Otio / Skybber — shared agent sandbox base image        (plan task B4a)
# =============================================================================
#
# WHY THIS EXISTS. In BYO-account mode there is no shared AI credential, so
# there is no unattended agentic workflow, so there is no gh-aw applier-job
# boundary. Untrusted issue text reaches an agent that holds a write-capable
# GitHub token and a shell. This image plus the firewall it starts with is the
# ONLY structural control in the design (plan finding S1). Everything else —
# `agent:go`, AGENTS.md's untrusted-input clause, the drift assertions — is a
# convention or a detection.
#
# THE DESIGN RULE. Nothing that carries host identity enters this image or the
# container built from it. The single credential is the `<slug>[bot]` GitHub App
# installation token, passed as an environment variable at container start,
# never baked in and never written to a file. See devcontainer.json.
#
# VERIFIED 2026-09-06 on darwin/arm64 (Docker Desktop, linux/arm64 engine):
# built, started, and `boundary-test.sh` passed with 0 boundary failures. See
# ../boundary-test-2026-09-06.md for the run and for the three defects the first
# execution found. A pass is evidence about one machine on one date — on any
# other machine, and after any edit to this file, the claims below are intent
# again until the test passes there.
# =============================================================================

# Node 24, not 22.
#   - trellis-web declares engines >=24 and .nvmrc 24.
#   - trellis declares engines >=22 and .nvmrc 22 — satisfied by 24.
#   - Node 24 is the org standard because npm Trusted Publishing needs npm
#     >= 11.5.1, and Node 22 ships npm 10.
# Pinned by digest, not tag: reproducible builds are a standing default and a
# floating tag is not one. This is the multi-arch INDEX digest (not a single
# platform's manifest digest), verified 2026-09-13 to cover both linux/amd64
# and linux/arm64 so it works unmodified on either machine architecture.
#
# To bump: change the tag below, then re-resolve and replace BOTH the tag and
# the digest together (a stale digest would silently re-pin the old image):
#   docker buildx imagetools inspect node:24-bookworm-slim --format '{{.Manifest.Digest}}'
# Verify the new digest is the index (not a per-arch manifest) before using it:
#   docker buildx imagetools inspect node:24-bookworm-slim@sha256:<digest>
# should print `manifests:` with both an amd64 and an arm64 entry.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
FROM ${NODE_IMAGE}

# gh CLI floor is 2.94.0 — the first release whose issue/sub-issue graph JSON
# this process depends on. 2.98.0 is what the operator runs today, so the
# container and the host agree. Raise this deliberately, never with `latest`.
ARG GH_VERSION=2.98.0

# Checksums for the .deb pinned to GH_VERSION above, one per arch this image
# supports. Taken from the release's own gh_${GH_VERSION}_checksums.txt and
# cross-verified 2026-09-13 by downloading each .deb and computing sha256
# independently (not copied from memory — see the Dockerfile history for the
# defect that note used to warn about).
#
# TO BUMP GH_VERSION: change the ARG above, then regenerate both checksums
# together — a stale checksum for a new version fails the build closed, which
# is correct, but don't "fix" it by deleting the check instead of updating it:
#   V=2.99.0
#   curl -fsSL -o /tmp/gh_checksums.txt \
#     "https://github.com/cli/cli/releases/download/v${V}/gh_${V}_checksums.txt"
#   grep -E "linux_(amd64|arm64)\.deb\$" /tmp/gh_checksums.txt
# Paste the two resulting hex digests into GH_DEB_SHA256_AMD64/ARM64 below.
ARG GH_DEB_SHA256_AMD64=f65a3fa2fa0eb2e97c445ee3f5e087a40aae03b64847f45a8f13805e504535d6
ARG GH_DEB_SHA256_ARM64=bbc4ac7964c2a091fd555cd1758d10a7cfcfdc472e405f0b0fb958f05d535cb6

ENV DEBIAN_FRONTEND=noninteractive

# -----------------------------------------------------------------------------
# Toolchain. Each line is here for a stated reason; anything without one is a
# widening of what every agent in the org can do and belongs in a reviewed PR.
# -----------------------------------------------------------------------------
#   ca-certificates, curl  — TLS + the firewall's own reachability probes
#   git                    — the point of the exercise
#   jq                     — gh JSON output is the work-graph interface
#   ripgrep                — the in-container research path (see B4c: doc-search
#                            is host-only, so Grep is not a fallback here, it is
#                            the mechanism)
#   iptables, ipset,
#   iproute2, dnsutils     — the egress firewall, run by the entrypoint as root
#   procps, less           — basic ergonomics for a human attaching to the box
#
# DELIBERATELY ABSENT, each an omission rather than an oversight:
#   sudo             — the agent user must never be able to touch the firewall.
#                      `node:24-bookworm-slim` ships without it; do not add it.
#   openssh-client   — no SSH keys are mounted, so `git@github.com:` remotes
#                      would fail anyway. Removing the client makes that a
#                      clear "command not found" instead of a hang, and removes
#                      agent-forwarding as a category.
#   awscli, scw      — the two cloud control planes this container exists to be
#                      unable to reach. Their absence is asserted by
#                      boundary-test.sh checks 1 and 2.
#   docker CLI       — see the note on /var/run/docker.sock in devcontainer.json.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      jq \
      ripgrep \
      iptables \
      ipset \
      iproute2 \
      dnsutils \
      procps \
      less \
 && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# gh CLI, pinned by version AND checksum.
# -----------------------------------------------------------------------------
# Fetched from the release, verified against the GH_DEB_SHA256_* pinned above
# (see the bump instructions there) with `sha256sum -c`, then the installed
# version is asserted against the floor as a second, independent check.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) gharch=amd64; expected="$GH_DEB_SHA256_AMD64" ;; \
      arm64) gharch=arm64; expected="$GH_DEB_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gh.deb \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gharch}.deb"; \
    printf '%s  %s\n' "$expected" /tmp/gh.deb > /tmp/gh.deb.sha256; \
    sha256sum -c /tmp/gh.deb.sha256; \
    dpkg -i /tmp/gh.deb; \
    rm -f /tmp/gh.deb /tmp/gh.deb.sha256; \
    # Fail the build, not the first PR, if the floor is not met.
    installed="$(gh --version | head -n1 | awk '{print $3}')"; \
    printf '%s\n%s\n' "2.94.0" "$installed" | sort -V -C \
      || { echo "gh $installed is below the 2.94.0 floor" >&2; exit 1; }

# -----------------------------------------------------------------------------
# repo-aegis — the answer to plan finding C9.
# -----------------------------------------------------------------------------
# Marker scanning is a HOST control: a Claude Code PostToolUse hook plus git
# hooks wired through a global core.hooksPath. This container strips host
# config by design, so without this section the leak-prevention control
# silently stops running inside it — and "it silently did not run" is already
# this control's recorded failure mode.
#
# Installed from the public npm registry, from outside any checkout, with
# lifecycle scripts disabled and the registry stated explicitly so a
# repo-supplied .npmrc cannot repoint it. Same shape as repo-aegis's own CI
# template.
#
# The deny set is NOT baked in. The engagement registry arrives as a read-only
# bind mount at runtime (see devcontainer.json), because the deny set is the
# list of strings we are trying not to leak and an image is a distributable
# artifact. This is the one deliberate, named exception to "mount nothing from
# the host" — see devcontainer/README.md, "The one host mount".
ARG REPO_AEGIS_VERSION=0.8.2
RUN npm install -g --ignore-scripts --registry=https://registry.npmjs.org \
      "@de-otio/repo-aegis@${REPO_AEGIS_VERSION}" \
 && repo-aegis --version

# -----------------------------------------------------------------------------
# System-level git config. /etc/gitconfig is ours; ~/.gitconfig is the host's
# and is never mounted (boundary-test.sh check 4 asserts its absence).
# -----------------------------------------------------------------------------
# The credential helper reads $GH_TOKEN at call time and writes nothing. This is
# the one place the injected token is used by git, and it is why no token ever
# appears in a remote URL or in .git/config.
RUN set -eux; \
    git config --system credential.helper \
      '!f() { test "$1" = get && printf "username=x-access-token\npassword=%s\n" "${GH_TOKEN}"; }; f'; \
    git config --system --add safe.directory '*'; \
    git config --system init.defaultBranch main; \
    # core.hooksPath inside the container points at a container-local directory,
    # not at the host's ~/.config/repo-aegis/hooks. The hooks themselves are
    # written by `repo-aegis install hooks` at first start (entrypoint), because
    # their content is a property of the installed repo-aegis version.
    git config --system core.hooksPath /opt/agent/hooks

# Two distinct locations, and the distinction matters:
#
#   REPO_AEGIS_REGISTRY  /opt/agent/registry/engagements.yaml
#       The host's engagement registry, bind-mounted READ-ONLY. The agent user
#       cannot edit it, so it cannot shrink its own deny set.
#
#   REPO_AEGIS_HOME      /opt/agent/repo-aegis
#       Container-local and root-owned. `repo-aegis render` writes the derived
#       marker files here at start; the agent user can read them and cannot
#       delete them. Only `state/` is agent-writable.
ENV REPO_AEGIS_HOME=/opt/agent/repo-aegis \
    REPO_AEGIS_REGISTRY=/opt/agent/registry/engagements.yaml
RUN mkdir -p /opt/agent/hooks /opt/agent/repo-aegis/state /opt/agent/registry \
 && chown -R root:root /opt/agent \
 && chmod 755 /opt/agent /opt/agent/hooks /opt/agent/repo-aegis /opt/agent/registry \
 && chown node:node /opt/agent/repo-aegis/state \
 && chmod 700 /opt/agent/repo-aegis/state

# This vendored copy differs from the canonical dot-work layout here. In
# dot-work itself the build context is `devcontainer/` (the parent of `base/`),
# so the canonical Dockerfile does `COPY base/init-firewall.sh ...` etc. In
# THIS repo all four files (Dockerfile, entrypoint.sh, init-firewall.sh,
# boundary-test.sh) sit flat inside `.devcontainer/`, and that directory IS the
# build context (docker-compose.devcontainer.yml: `context: .devcontainer`,
# `dockerfile: Dockerfile` — see that file's comment for why it is spelled
# `.devcontainer` rather than `.`: docker compose resolves relative paths
# against the repo root, not against this file's own directory) — so the COPY
# sources below have no `base/` prefix. Do not "fix" this to match the base's
# own comment; the two layouts are genuinely different on purpose, and
# re-adding `base/` here would break the build in this repo.
COPY init-firewall.sh /usr/local/sbin/init-firewall.sh
COPY entrypoint.sh    /usr/local/sbin/entrypoint.sh
COPY boundary-test.sh /usr/local/bin/boundary-test.sh
RUN chmod 0755 /usr/local/sbin/init-firewall.sh \
               /usr/local/sbin/entrypoint.sh \
               /usr/local/bin/boundary-test.sh \
 && chown root:root /usr/local/sbin/init-firewall.sh \
                    /usr/local/sbin/entrypoint.sh

# -----------------------------------------------------------------------------
# Lock root. The container process starts as root so the entrypoint can install
# firewall rules; every interactive session and every agent runs as `node`
# (uid 1000, from the official image). With no sudo and a locked root password
# there is no path from `node` back to root, which is what makes the firewall a
# control rather than a suggestion.
# -----------------------------------------------------------------------------
RUN passwd -l root

ENV GH_NO_UPDATE_NOTIFIER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    AGENT_SANDBOX=1

WORKDIR /workspace
ENTRYPOINT ["/usr/local/sbin/entrypoint.sh"]
CMD ["sleep", "infinity"]
