#!/usr/bin/env bash
# Fetch + verify the p2-inc/keycloak-magic-link extension JAR for the
# Scaleway-profile compose stack (docker-compose.scaleway.yml).
#
# Reproducible, verified acquisition — same procedure/pins as the G2 spike
# (spikes/keycloak-magic-link/providers/fetch-provider.sh, security F8):
# GPG signature + sha256. The JAR itself is gitignored; run this before
# `docker compose -f docker-compose.scaleway.yml up`.
set -euo pipefail

VERSION="0.73"                    # builds against keycloak.version 26.6.3 (its pom)
EXPECTED_SHA256="181999f67180376c499fed6521c74e4b922ce9588d7253c59e8519134acdbbcc"
SIGNING_FPR="51E5BAA1B195629172C33395BC6B4EADEB514AFD"  # phasetwo-bot <bot@phasetwo.io>

cd "$(dirname "$0")"
mkdir -p providers
cd providers

BASE="https://repo1.maven.org/maven2/io/phasetwo/keycloak/keycloak-magic-link/${VERSION}"
JAR="keycloak-magic-link-${VERSION}.jar"

if [ -f "${JAR}" ]; then
  ACTUAL=$(shasum -a 256 "${JAR}" 2>/dev/null | awk '{print $1}' || sha256sum "${JAR}" | awk '{print $1}')
  if [ "${ACTUAL}" = "${EXPECTED_SHA256}" ]; then
    echo "==> provider already present + sha256 ok: ${JAR}"
    exit 0
  fi
  echo "==> existing ${JAR} has wrong sha256; re-fetching" >&2
  rm -f "${JAR}" "${JAR}.asc"
fi

echo "==> downloading ${JAR} + signature"
curl -sSf -o "${JAR}"       "${BASE}/${JAR}"
curl -sSf -o "${JAR}.asc"   "${BASE}/${JAR}.asc"

echo "==> sha256"
ACTUAL=$(shasum -a 256 "${JAR}" 2>/dev/null | awk '{print $1}' || sha256sum "${JAR}" | awk '{print $1}')
if [ "${ACTUAL}" != "${EXPECTED_SHA256}" ]; then
  echo "FAIL sha256 mismatch: got ${ACTUAL}" >&2; exit 1
fi
echo "    ok ${ACTUAL}"

echo "==> gpg signature (expect ${SIGNING_FPR})"
KEYID=$(gpg --list-packets "${JAR}.asc" | grep -oE 'keyid [0-9A-F]+' | head -1 | awk '{print $2}')
gpg --keyserver hkps://keyserver.ubuntu.com --recv-keys "${KEYID}" 2>/dev/null || \
  gpg --keyserver hkps://keys.openpgp.org --recv-keys "${KEYID}" 2>/dev/null || true
if gpg --verify "${JAR}.asc" "${JAR}" 2>&1 | grep -q "${SIGNING_FPR}"; then
  echo "    ok good signature from ${SIGNING_FPR}"
else
  echo "FAIL gpg signature not from expected key" >&2; exit 1
fi
echo "==> provider ready: ${JAR}"
