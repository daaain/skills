#!/usr/bin/env bash
#
# Integration tests for devcontainer-security hardening.
#
# Builds and starts the devcontainer using @devcontainers/cli, then runs
# verification checks from the host. This is the TDD loop for container
# security: run tests, fix config, re-run until green.
#
# Usage:
#   bash scripts/run-integration-tests.sh [workspace-folder]
#
# Requires: Docker (with Compose v2), Node.js (npx)
# Output:   TAP format (Test Anything Protocol)

set -euo pipefail

WORKSPACE="${1:-.}"
WORKSPACE="$(cd "$WORKSPACE" && pwd)"
CONTAINER_ID=""
TESTS=0
FAILURES=0

# ─── Helpers ──────────────────────────────────────────────────────────────────

tap_pass() { TESTS=$((TESTS + 1)); echo "ok $TESTS - $1"; }
tap_fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); echo "not ok $TESTS - $1"; }

cleanup() {
  echo "# Cleaning up..."
  docker compose -f "$WORKSPACE/.devcontainer/docker-compose.yml" \
    down --volumes --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

devcontainer_exec() {
  npx -y @devcontainers/cli exec --workspace-folder "$WORKSPACE" "$@"
}

# ─── Prerequisites ────────────────────────────────────────────────────────────

for cmd in docker npx; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Bail out! Required command not found: $cmd"
    exit 1
  fi
done

if ! docker compose version &>/dev/null; then
  echo "Bail out! Docker Compose v2 not found (docker compose version failed)"
  exit 1
fi

# ─── Build and start ─────────────────────────────────────────────────────────

echo "# Building and starting devcontainer from: $WORKSPACE"

UP_OUTPUT=$(npx -y @devcontainers/cli up --workspace-folder "$WORKSPACE" 2>&1) || {
  echo "Bail out! devcontainer up failed:"
  echo "$UP_OUTPUT"
  exit 1
}

CONTAINER_ID=$(echo "$UP_OUTPUT" | sed -n 's/.*"containerId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$CONTAINER_ID" ]; then
  echo "Bail out! Could not extract container ID from devcontainer up output"
  echo "$UP_OUTPUT"
  exit 1
fi
echo "# Container ID: $CONTAINER_ID"

# ─── Wait for docker proxy readiness ─────────────────────────────────────────

echo "# Waiting for docker proxy..."
PROXY_READY=0
for i in $(seq 1 15); do
  if devcontainer_exec docker ps &>/dev/null; then
    PROXY_READY=1
    break
  fi
  echo "# Attempt $i/15 — proxy not ready, retrying in 2s..."
  sleep 2
done

if [ "$PROXY_READY" -eq 0 ]; then
  echo "Bail out! Docker proxy did not become ready after 30s"
  exit 1
fi

# ─── Tests ────────────────────────────────────────────────────────────────────

echo "TAP version 13"
echo "1..11"

# 1. Hardening script exists
if devcontainer_exec bash -c 'test -f ~/.config/security-harden.sh'; then
  tap_pass "hardening script exists at ~/.config/security-harden.sh"
else
  tap_fail "hardening script missing at ~/.config/security-harden.sh"
fi

# 2. .bashrc sources hardening on line 1
BASHRC_LINE1=$(devcontainer_exec bash -c 'head -1 ~/.bashrc' 2>/dev/null || echo "")
if echo "$BASHRC_LINE1" | grep -q 'security-harden.sh'; then
  tap_pass ".bashrc sources hardening script on line 1"
else
  tap_fail ".bashrc does not source hardening script on line 1 (got: $BASHRC_LINE1)"
fi

# 3. Env vars cleared — VSCODE_IPC_HOOK_CLI injected then checked
if RESULT=$(docker exec -e VSCODE_IPC_HOOK_CLI=/tmp/fake "$CONTAINER_ID" \
  bash -lc 'echo "${VSCODE_IPC_HOOK_CLI:-}"' 2>/dev/null); then
  if [ -z "$RESULT" ]; then
    tap_pass "VSCODE_IPC_HOOK_CLI cleared after injection"
  else
    tap_fail "VSCODE_IPC_HOOK_CLI not cleared (got: $RESULT)"
  fi
else
  tap_fail "VSCODE_IPC_HOOK_CLI check — docker exec failed"
fi

# 4. Agent vars set to empty — SSH_AUTH_SOCK injected then checked
if RESULT=$(docker exec -e SSH_AUTH_SOCK=/tmp/fake "$CONTAINER_ID" \
  bash -lc 'echo "${SSH_AUTH_SOCK}"' 2>/dev/null); then
  if [ -z "$RESULT" ]; then
    tap_pass "SSH_AUTH_SOCK cleared after injection"
  else
    tap_fail "SSH_AUTH_SOCK not cleared (got: $RESULT)"
  fi
else
  tap_fail "SSH_AUTH_SOCK check — docker exec failed"
fi

# 5. No sudo
if devcontainer_exec command -v sudo &>/dev/null; then
  tap_fail "sudo is installed"
else
  tap_pass "sudo is not installed"
fi

# 6. Non-root user
WHOAMI=$(devcontainer_exec whoami 2>/dev/null || echo "unknown")
if [ "$WHOAMI" != "root" ]; then
  tap_pass "running as non-root user ($WHOAMI)"
else
  tap_fail "running as root"
fi

# 7. Capabilities dropped
CAP_EFF=$(devcontainer_exec grep CapEff /proc/self/status 2>/dev/null || echo "unknown")
if echo "$CAP_EFF" | grep -q '0000000000000000'; then
  tap_pass "all capabilities dropped"
else
  tap_fail "capabilities not fully dropped ($CAP_EFF)"
fi

# 8. No new privileges
NO_NEW_PRIVS=$(devcontainer_exec grep NoNewPrivs /proc/self/status 2>/dev/null || echo "unknown")
if echo "$NO_NEW_PRIVS" | grep -qE '[[:space:]]1$'; then
  tap_pass "no-new-privileges enforced"
else
  tap_fail "no-new-privileges not enforced ($NO_NEW_PRIVS)"
fi

# 9. Docker read access
if devcontainer_exec docker ps &>/dev/null; then
  tap_pass "docker ps works (read access via proxy)"
else
  tap_fail "docker ps failed"
fi

# 10. Docker write blocked
if devcontainer_exec docker run --rm alpine echo test &>/dev/null; then
  tap_fail "docker run succeeded (should be blocked by proxy)"
else
  tap_pass "docker run blocked by proxy"
fi

# 11. SSH agent unavailable
if devcontainer_exec bash -c 'test -z "${SSH_AUTH_SOCK}" -o ! -S "${SSH_AUTH_SOCK:-/x}"'; then
  tap_pass "SSH agent unavailable"
else
  tap_fail "SSH agent is accessible"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "# All $TESTS tests passed"
else
  echo "# $FAILURES of $TESTS tests failed"
fi

exit "$( [ "$FAILURES" -eq 0 ] && echo 0 || echo 1 )"
