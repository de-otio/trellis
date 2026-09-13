#!/bin/sh
# Vendored from de-otio/dot-work devcontainer/base at 7615bc703f6fa7bda32b8cc0d49f6f8ac0df6121 on 2026-09-13; do not edit here, edit the base and re-vendor.
# =============================================================================
# Agent sandbox boundary test                                (plan task B4d)
#
# RUN THIS FROM INSIDE THE CONTAINER, as the agent user (`node`), with the
# workspace folder as the working directory:
#
#     devcontainer exec --workspace-folder . /usr/local/bin/boundary-test.sh
#
# Exits non-zero if any assertion fails. Record the result, with the date and
# the exact command, in process/verification-log.md. A pass from three months
# ago against a config that has since changed is not evidence.
# =============================================================================
#
# WHY THIS SCRIPT HAS A TEST THAT MUST *PASS*.
#
# B4c and C9 are the same mistake pointing in opposite directions. Both are
# host configuration that the container, by design, does not inherit:
#
#   * doc-search stops working. The MCP server talks to ollama on the host at
#     localhost:11434. It breaks VISIBLY — the first search returns nothing —
#     so it gets fixed, and the cheapest fix on a deadline is to punch a hole
#     in the egress allowlist or turn it off. A control that gets disabled to
#     unblock someone is worse than one that was never claimed.
#
#   * Marker scanning stops running. It is a PostToolUse hook plus git hooks
#     wired through a global core.hooksPath, all of it host config. It breaks
#     INVISIBLY: commits succeed, scans report clean, nothing is scanned. The
#     recorded failure mode for this control is already "it silently did not
#     run" — a clean report and an absent report look identical.
#
# So three checks that must fail are not enough. Anything that fails loudly
# gets noticed by the person it inconveniences. The dangerous failure is the
# control that reports success while doing nothing, and the only way to test
# for that is to plant something it must catch and assert that it caught it.
# That is check 7, and it is the reason this file exists.
# =============================================================================

FAILURES=0
BOUNDARY_FAILURES=0
CAPABILITY_FAILURES=0
SKIPPED=0
CHECK=0

# Two lanes, counted separately, because they mean opposite things.
#
#   fail()  BOUNDARY. Something that must not be reachable is reachable, or a
#           control that must fire did not. Never acceptable. Never skippable.
#   cfail() CAPABILITY. The container cannot do its job. A real defect, but it
#           does not mean host credentials are in reach.
#
# The distinction exists because B4d's contract is about the boundary, and a
# boundary-certification run is deliberately performed with NO GitHub token —
# the plan's own stop condition forbids a write-capable token existing on a
# machine before this test has passed, so requiring one to run the test is
# circular. Without the split, that run reports a red result whose single
# failure is "you followed the rule", and a red result nobody can make green is
# a result people learn to ignore.
pass()  { CHECK=$((CHECK + 1)); printf 'PASS  [%02d] %s\n' "$CHECK" "$1"; }
fail()  { CHECK=$((CHECK + 1)); FAILURES=$((FAILURES + 1)); BOUNDARY_FAILURES=$((BOUNDARY_FAILURES + 1)); printf 'FAIL  [%02d] %s\n      -> %s\n' "$CHECK" "$1" "$2"; }
cfail() { CHECK=$((CHECK + 1)); FAILURES=$((FAILURES + 1)); CAPABILITY_FAILURES=$((CAPABILITY_FAILURES + 1)); printf 'FAIL  [%02d] (capability) %s\n      -> %s\n' "$CHECK" "$1" "$2"; }
skip()  { CHECK=$((CHECK + 1)); SKIPPED=$((SKIPPED + 1)); printf 'SKIP  [%02d] %s\n      -> %s\n' "$CHECK" "$1" "$2"; }
note() { printf '           %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
EXPECTED_NODE_MAJOR="${EXPECTED_NODE_MAJOR:-24}"

# Every marker-scanning artefact this script creates lives here and is removed
# on every exit path, including interrupt. A planted canary left in a working
# tree is a self-inflicted incident.
CANARY_DIR="$REPO_ROOT/.agent-boundary-probe"
SCRATCH_REPO="${TMPDIR:-/tmp}/agent-boundary-hookprobe.$$"
cleanup() { rm -rf "$CANARY_DIR" "$SCRATCH_REPO" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

printf 'agent sandbox boundary test\n'
printf 'repo:  %s\n' "$REPO_ROOT"
printf 'user:  %s (uid %s)\n' "$(id -un)" "$(id -u)"
printf 'date:  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# =============================================================================
section "MUST FAIL — host credentials are out of reach"
# =============================================================================
#
# All three assert on OUTCOME ("no credential was retrieved"), never on an
# error string. Inside a Linux container the binary usually does not exist at
# all, and "command not found" IS the pass: there is nothing to call the cloud
# with. Asserting on a specific message would make the test brittle against a
# future image that happens to include the CLI but no credentials — which must
# also pass, for the same reason.

# --- 1 ---------------------------------------------------------------------
if ! command -v aws >/dev/null 2>&1; then
  pass "aws sts get-caller-identity — no AWS CLI in the image"
elif aws sts get-caller-identity >/dev/null 2>&1; then
  fail "aws sts get-caller-identity" "SUCCEEDED — the container holds usable AWS credentials. Stop; do not use this container for agent work."
else
  pass "aws sts get-caller-identity — CLI present, call refused"
fi

# --- 2 ---------------------------------------------------------------------
if ! command -v scw >/dev/null 2>&1; then
  pass "scw account project list — no Scaleway CLI in the image"
elif scw account project list >/dev/null 2>&1; then
  fail "scw account project list" "SUCCEEDED — the container holds usable Scaleway credentials."
else
  # A malformed/unauthenticated scw call can print a JSON error object; the
  # exit status is what is asserted, never the output shape.
  pass "scw account project list — CLI present, call refused"
fi

# --- 3 ---------------------------------------------------------------------
# The macOS login keychain. On Linux the binary does not exist, which is itself
# the pass — the keychain is not merely locked, it is not addressable. The
# assertion is "no credential was retrieved", not "a particular error appeared".
if ! command -v security >/dev/null 2>&1; then
  pass "security find-generic-password — no macOS keychain tool (Linux container)"
elif security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then
  fail "security find-generic-password" "RETRIEVED A CREDENTIAL — the host keychain is reachable."
else
  pass "security find-generic-password — no credential retrieved"
fi

# =============================================================================
section "MUST FAIL — no host identity was mounted"
# =============================================================================
# The three checks above can pass for the wrong reason (a missing binary) while
# the credentials themselves are sitting in the filesystem. These assert the
# absence directly, so a later image that adds the AWS CLI does not silently
# turn a real boundary into an accident.

check_absent() {
  if [ -e "$1" ]; then
    fail "$1 is not mounted" "EXISTS — remove this mount from devcontainer.json"
  else
    pass "$1 is not mounted"
  fi
}
check_absent "$HOME/.aws"
check_absent "$HOME/.ssh"
check_absent "$HOME/.config/scw"
check_absent "$HOME/.config/gh"
check_absent "$HOME/.gitconfig"
check_absent "$HOME/.kube"
check_absent "/var/run/docker.sock"

# SSH agent forwarding is ON BY DEFAULT in VS Code's Dev Containers extension
# whenever a host agent is running, and it cannot be disabled from
# devcontainer.json. This is the assertion that catches an operator who did not
# set the host-side prerequisite.
if [ -n "${SSH_AUTH_SOCK:-}" ]; then
  fail "no SSH agent is forwarded" "SSH_AUTH_SOCK is set — host SSH keys are usable from inside the container"
else
  pass "no SSH agent is forwarded"
fi

# Likewise the git credential helper VS Code proxies back to the host.
HELPER=$(git config --get-all credential.helper 2>/dev/null | grep -v 'x-access-token' || true)
if [ -n "$HELPER" ]; then
  fail "no host git credential helper" "found an unexpected credential.helper — the host's git credentials may be reachable"
else
  pass "no host git credential helper (only the GH_TOKEN helper from /etc/gitconfig)"
fi

ENVFILES=$(find "$REPO_ROOT" -maxdepth 2 \( -name '.env' -o -name '.env.*' \) 2>/dev/null | head -n 5)
if [ -n "$ENVFILES" ]; then
  fail "no .env* file in the workspace" "found: $(printf '%s' "$ENVFILES" | tr '\n' ' ')"
else
  pass "no .env* file in the workspace"
fi

# =============================================================================
section "MUST FAIL — egress is denied by default"
# =============================================================================
# Checks 1 and 2 would also pass with no firewall at all (no CLI, no config).
# These separate the two controls, so a pass is attributed to the control that
# actually produced it. A test that passes for the wrong reason is not evidence.

denied_host() {
  # $1 = label, $2 = URL
  if curl --silent --max-time 6 --output /dev/null "$2" 2>/dev/null; then
    fail "$1 is unreachable" "REACHED $2 — there is no egress boundary in this container"
  else
    pass "$1 is unreachable"
  fi
}
denied_host "AWS control plane"      "https://sts.amazonaws.com/"
denied_host "Scaleway control plane" "https://api.scaleway.com/"
denied_host "instance metadata"      "http://169.254.169.254/latest/meta-data/"

# The B4c decision, enforced rather than merely written down: doc-search runs
# against ollama on the host, and the host route is deliberately closed. If this
# check starts failing, somebody punched the hole — see devcontainer/README.md
# before deciding that was fine.
denied_host "host ollama / doc-search (B4c: host-only)" "http://host.docker.internal:11434/"

# =============================================================================
section "MUST FAIL — the agent user cannot undo the boundary"
# =============================================================================
if command -v sudo >/dev/null 2>&1; then
  fail "no sudo in the container" "sudo is installed — the firewall is removable by the thing it constrains"
else
  pass "no sudo in the container"
fi

if iptables -L >/dev/null 2>&1; then
  fail "agent user cannot read/alter iptables" "iptables succeeded as $(id -un)"
else
  pass "agent user cannot read/alter iptables"
fi

# =============================================================================
section "MUST PASS — the marker-scanning control actually fires (finding C9)"
# =============================================================================
#
# This is the check the whole script exists for. It does not assert that a
# config file is present, that core.hooksPath has a value, or that repo-aegis is
# installed. It plants something the scanner must catch and asserts the catch.
#
# THE CANARY IS GENERATED AT RUN TIME, and that is deliberate, for three
# reasons:
#
#   1. A literal marker written into this file would be caught by repo-aegis
#      the moment anyone tried to commit dot-work — the test would block its
#      own repo.
#   2. A fresh random value cannot be a real credential belonging to anyone.
#   3. Verified on the host against repo-aegis 0.8.2: the well-known AWS
#      *documentation example* key (the AKIA…EXAMPLE one) is NOT flagged by
#      `repo-aegis check`, even though `repo-aegis markers test` reports it as
#      a pattern match — there is a known-example filter in the scan path. A
#      test written with that value fails while reporting "clean", which is the
#      exact confusion this check exists to eliminate.
#
# The generated value matches the universal (always-block) access-key pattern,
# so this check works in any repo regardless of class or engagement allowances.

if ! command -v repo-aegis >/dev/null 2>&1; then
  fail "marker scanning fires on a planted canary" "repo-aegis is not installed in the container — the leak-prevention control is absent"
else
  CANARY="AKIA$(LC_ALL=C tr -dc 'A-Z0-9' < /dev/urandom 2>/dev/null | head -c 16)"
  if [ ${#CANARY} -ne 20 ]; then
    fail "marker scanning fires on a planted canary" "could not generate a canary (got ${#CANARY} chars)"
  else
    mkdir -p "$CANARY_DIR"
    printf 'boundary-test canary %s\n' "$CANARY" > "$CANARY_DIR/canary.txt"
    repo-aegis --cwd "$REPO_ROOT" check --path "$CANARY_DIR/canary.txt" --require-deny-set >/dev/null 2>&1
    AEGIS_RC=$?
    case "$AEGIS_RC" in
      1) pass "marker scanning fires on a planted canary (repo-aegis exit 1 = finding)" ;;
      0) fail "marker scanning fires on a planted canary" \
              "repo-aegis reported CLEAN. The scan ran and caught nothing, or skipped the file. This is the silent-failure mode; do not use this container." ;;
      2) fail "marker scanning fires on a planted canary" \
              "repo-aegis exit 2 = empty deny set or usage error. The engagement registry mount is probably missing." ;;
      *) fail "marker scanning fires on a planted canary" "unexpected repo-aegis exit $AEGIS_RC" ;;
    esac
    rm -rf "$CANARY_DIR"
  fi

  # --- the deny set is more than the universal patterns ---------------------
  # `_always` alone (secret shapes: access keys, tokens, private-key headers)
  # is 6 patterns and needs no registry. If that is all that loaded, the scan
  # above still passes while every engagement-scoped marker goes undetected —
  # the recorded real-world failure was an EMPTY engagement marker set, not an
  # absent tool. Threshold is deliberately just above the universal count.
  AEGIS_MIN_PATTERNS="${AEGIS_MIN_PATTERNS:-7}"
  mkdir -p "$CANARY_DIR"
  printf 'boundary-test clean probe\n' > "$CANARY_DIR/clean.txt"
  repo-aegis --cwd "$REPO_ROOT" check --path "$CANARY_DIR/clean.txt" \
    --min-patterns "$AEGIS_MIN_PATTERNS" >/dev/null 2>&1
  MIN_RC=$?
  rm -rf "$CANARY_DIR"
  case "$MIN_RC" in
    0) pass "deny set is engagement-scoped, not universal-only (>= $AEGIS_MIN_PATTERNS patterns)" ;;
    2) fail "deny set is engagement-scoped, not universal-only" \
            "fewer than $AEGIS_MIN_PATTERNS patterns loaded — the read-only engagement registry mount is missing or empty" ;;
    *) fail "deny set is engagement-scoped, not universal-only" \
            "unexpected repo-aegis exit $MIN_RC on a known-clean file" ;;
  esac

  # --- the git hook wiring, exercised rather than inspected ------------------
  # A scratch repo, so the workspace's index is never touched. core.hooksPath is
  # set system-wide in the image, so any repo in the container inherits it —
  # which is precisely the wiring under test.
  HOOKS_DIR=$(git rev-parse --git-path hooks 2>/dev/null)
  if [ -x "$HOOKS_DIR/pre-commit" ]; then
    mkdir -p "$SCRATCH_REPO"
    ( cd "$SCRATCH_REPO" && git init -q . ) 2>/dev/null
    HCANARY="AKIA$(LC_ALL=C tr -dc 'A-Z0-9' < /dev/urandom 2>/dev/null | head -c 16)"
    printf 'hook probe %s\n' "$HCANARY" > "$SCRATCH_REPO/probe.txt"
    ( cd "$SCRATCH_REPO" && git add probe.txt >/dev/null 2>&1 && "$HOOKS_DIR/pre-commit" >/dev/null 2>&1 )
    HOOK_RC=$?
    if [ "$HOOK_RC" -ne 0 ]; then
      pass "git pre-commit hook refuses a staged canary (hooksPath: $HOOKS_DIR)"
    else
      fail "git pre-commit hook refuses a staged canary" \
           "the hook exited 0 on staged canary content — commits carrying markers would go through"
    fi
    rm -rf "$SCRATCH_REPO"
  else
    fail "git pre-commit hook refuses a staged canary" \
         "no executable pre-commit at core.hooksPath ($HOOKS_DIR) — git-level marker scanning is not wired in this container"
  fi
fi

# =============================================================================
section "MUST PASS — the intended capabilities work"
# =============================================================================

# --- gh, on the injected installation token --------------------------------
# AGENT_EXPECT_NO_TOKEN=1 is the BOUNDARY-CERTIFICATION mode: assert the
# boundary on a machine that deliberately holds no `<slug>[bot]` token, which is
# the only order the plan's stop condition permits (B4d passes first, the token
# is minted second). It is opt-in, it is printed loudly, and it downgrades
# exactly one check. A normal work session that simply forgot to export
# AGENT_GH_TOKEN still fails, because it will not have set this.
if [ -z "${GH_TOKEN:-}" ] && [ "${AGENT_EXPECT_NO_TOKEN:-0}" = "1" ]; then
  skip "gh auth status succeeds on the injected token" \
       "AGENT_EXPECT_NO_TOKEN=1 — boundary-certification run, no token by design. GitHub capability is NOT proven by this run."
elif [ -z "${GH_TOKEN:-}" ]; then
  cfail "gh auth status succeeds on the injected token" \
       "GH_TOKEN is empty — set AGENT_GH_TOKEN in the launching shell (see devcontainer.json remoteEnv)"
elif gh auth status >/dev/null 2>&1; then
  pass "gh auth status succeeds on the injected token"
  # Confirms the token is an INSTALLATION token, not a user token. Full scope
  # proof is plan A3's probe matrix; this is the one-call smoke test.
  if gh api /installation/repositories >/dev/null 2>&1; then
    pass "token is an installation token (/installation/repositories = 200)"
  else
    cfail "token is an installation token" "/installation/repositories did not succeed"
    note "this may be a user token — run the plan A3 probe matrix before using it"
  fi
else
  cfail "gh auth status succeeds on the injected token" "gh auth status failed"
fi

# --- git works: the B4b decision, verified ---------------------------------
# A git worktree's .git is a FILE containing `gitdir: <path outside the mount>`,
# so a container opened on a worktree has no usable git at all. The B4b decision
# is that agents work in CLONES. This check is what makes that decision testable
# instead of aspirational: if someone opens the container on a worktree path,
# this fails here rather than three commands into a task.
if [ -f "$REPO_ROOT/.git" ]; then
  cfail "git works (workspace is a clone, not a worktree)" \
       "$REPO_ROOT/.git is a FILE (a worktree gitdir pointer). See B4b: agents work in clones."
elif [ ! -d "$REPO_ROOT/.git" ]; then
  cfail "git works (workspace is a clone, not a worktree)" "no .git directory at $REPO_ROOT"
elif git -C "$REPO_ROOT" status --porcelain >/dev/null 2>&1 && git -C "$REPO_ROOT" log -1 >/dev/null 2>&1; then
  pass "git works (workspace is a clone: .git is a real directory, status and log succeed)"
else
  cfail "git works (workspace is a clone, not a worktree)" "git status or git log failed inside the container"
fi

# --- node ------------------------------------------------------------------
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "none")
if [ "$NODE_MAJOR" = "$EXPECTED_NODE_MAJOR" ]; then
  pass "node major is $EXPECTED_NODE_MAJOR ($(node --version))"
else
  cfail "node major is $EXPECTED_NODE_MAJOR" "got '$NODE_MAJOR'"
fi

# --- gh version floor ------------------------------------------------------
GH_VER=$(gh --version 2>/dev/null | head -n1 | awk '{print $3}')
if [ -n "$GH_VER" ] && printf '%s\n%s\n' "2.94.0" "$GH_VER" | sort -V -C 2>/dev/null; then
  pass "gh $GH_VER meets the 2.94.0 floor (issue-graph JSON)"
else
  cfail "gh meets the 2.94.0 floor" "got '${GH_VER:-none}'"
fi

# --- allowed egress --------------------------------------------------------
#
# Retried, and the retry is the assertion — not a flake-hider.
#
# The firewall allowlists DOMAINS but installs IP rules, and hosts like
# `api.github.com` serve one A record from a rotating pool. The property the
# design actually claims is therefore "an allowlisted host is reachable, and
# stays reachable, because a root-owned refresher re-resolves the domain list
# every AGENT_REFRESH_SECONDS and adds what it finds". A single-shot probe
# asserts a STRICTER property than that — "reachable at this instant, with zero
# convergence time" — and fails whenever it lands in the catch-up window.
# Observed on the first build (2026-09-06): a rotation mid-session produced
# exactly that false red while the boundary was entirely intact.
#
# So the probe is given the convergence window the design promises, and no more.
# It never retries a MUST-FAIL check: a blocked host that becomes reachable on
# retry is a boundary failure, and those are asserted single-shot above.
EGRESS_RETRIES="${EGRESS_RETRIES:-4}"
EGRESS_RETRY_SLEEP="${EGRESS_RETRY_SLEEP:-15}"

allowed_host() {
  # $1 = label, $2 = URL, $3 = failure message
  i=1
  while [ "$i" -le "$EGRESS_RETRIES" ]; do
    if curl --silent --max-time 10 --output /dev/null "$2"; then
      if [ "$i" -eq 1 ]; then
        pass "$1"
      else
        pass "$1 (reachable after $i attempts — an allowlist refresh converged)"
      fi
      return 0
    fi
    i=$((i + 1))
    [ "$i" -le "$EGRESS_RETRIES" ] && sleep "$EGRESS_RETRY_SLEEP"
  done
  cfail "$1" "$3 (still unreachable after $EGRESS_RETRIES attempts over ~$((EGRESS_RETRIES * EGRESS_RETRY_SLEEP))s)"
}

allowed_host "api.github.com is reachable (allowlist is tight, not broken)" \
             "https://api.github.com/zen" \
             "the allowlist blocks GitHub — the container cannot do its job"

allowed_host "registry.npmjs.org is reachable (npm ci can run)" \
             "https://registry.npmjs.org/" \
             "npm ci will fail in this container"

# =============================================================================
printf '\n'
printf 'checks: %d   boundary failures: %d   capability failures: %d   skipped: %d\n' \
  "$CHECK" "$BOUNDARY_FAILURES" "$CAPABILITY_FAILURES" "$SKIPPED"

if [ "$SKIPPED" -gt 0 ]; then
  printf 'NOTE: %d check(s) skipped — this run does NOT prove those capabilities.\n' "$SKIPPED"
fi

if [ "$FAILURES" -eq 0 ]; then
  printf 'RESULT: PASS — %d checks, 0 failures\n' "$CHECK"
  printf 'B4d contract held: aws / scw / security all failed to yield a credential,\n'
  printf 'and the marker-scanning control fired on a planted canary.\n'
  printf 'Record this run in process/verification-log.md with the date and the exact command.\n'
  exit 0
fi

if [ "$BOUNDARY_FAILURES" -eq 0 ]; then
  # Capability-only failure. Say so plainly: the container is broken as a
  # workspace, but nothing asserts that host credentials came within reach.
  # It is still a non-zero exit — a container that cannot do its job is not
  # fit to certify — but the operator needs to know which repair this is.
  printf 'RESULT: FAIL (capability only) — %d checks, %d capability failure(s), 0 boundary failures\n' \
    "$CHECK" "$CAPABILITY_FAILURES"
  printf '\n'
  printf 'The boundary held: no host credential was reachable and the marker-scanning\n'
  printf 'control fired. What failed is the container'"'"'s ability to do its job.\n'
  printf 'Fix the capability, then re-run. Do NOT widen the egress allowlist to do it.\n'
  exit 1
fi

printf 'RESULT: FAIL — %d checks, %d failure(s) (%d BOUNDARY)\n' \
  "$CHECK" "$FAILURES" "$BOUNDARY_FAILURES"
printf '\n'
printf 'Plan stop condition: a write-capable <slug>[bot] token must not exist on a\n'
printf 'machine where this test has not passed. Fix the container, not the token.\n'
exit 1
