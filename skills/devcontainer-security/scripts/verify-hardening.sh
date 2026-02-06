#!/usr/bin/env bash
#
# DevContainer Security Hardening Verification
#
# Checks that security controls are effective. Run inside the dev container:
#   bash .claude/skills/devcontainer-security/scripts/verify-hardening.sh
#
# Exit code 0 = all critical checks pass
# Exit code 1 = one or more critical checks failed

set -euo pipefail

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No colour

FAILURES=0
WARNINGS=0

pass() { echo -e "  ${GREEN}PASS${NC}  $1"; }
fail() { echo -e "  ${RED}FAIL${NC}  $1"; FAILURES=$((FAILURES + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}  $1"; WARNINGS=$((WARNINGS + 1)); }
info() { echo -e "  ${BLUE}INFO${NC}  $1"; }

echo ""
echo "=========================================="
echo " DevContainer Security Verification"
echo "=========================================="

# ─── 1. Environment Variables ────────────────────────────────────────────────

echo ""
echo "── Environment Variables ──"

# Critical escape vector variables that MUST be cleared
CRITICAL_VARS=(
  VSCODE_IPC_HOOK_CLI
  BROWSER
  GIT_ASKPASS
  VSCODE_GIT_ASKPASS_MAIN
  VSCODE_GIT_IPC_HANDLE
)

for var in "${CRITICAL_VARS[@]}"; do
  val="${!var:-}"
  if [ -z "$val" ]; then
    pass "$var is cleared"
  else
    fail "$var is still set: '$val'"
  fi
done

# Additional variables (important but less critical)
EXTRA_VARS=(
  REMOTE_CONTAINERS_IPC
  REMOTE_CONTAINERS_SOCKETS
  REMOTE_CONTAINERS_DISPLAY_SOCK
  VSCODE_GIT_ASKPASS_NODE
  VSCODE_GIT_ASKPASS_EXTRA_ARGS
  WAYLAND_DISPLAY
)

for var in "${EXTRA_VARS[@]}"; do
  val="${!var:-}"
  if [ -z "$val" ]; then
    pass "$var is cleared"
  else
    warn "$var is still set: '$val'"
  fi
done

# Agent variables should be empty string (not unset)
for var in SSH_AUTH_SOCK GPG_AGENT_INFO; do
  if [ -z "${!var+x}" ]; then
    warn "$var is unset (should be empty string to prevent fallback)"
  elif [ -z "${!var}" ]; then
    pass "$var is set to empty"
  else
    fail "$var has a value: '${!var}'"
  fi
done

# ─── 2. Socket Files ────────────────────────────────────────────────────────

echo ""
echo "── Socket Files ──"

ESCAPE_SOCKETS=$(find /tmp -maxdepth 2 \( \
  -name 'vscode-ssh-auth-*.sock' -o \
  -name 'vscode-remote-containers-ipc-*.sock' -o \
  -name 'vscode-git-*.sock' \
\) 2>/dev/null || true)

if [ -z "$ESCAPE_SOCKETS" ]; then
  pass "No escape vector sockets found (SSH, remote-containers, git)"
else
  fail "Escape vector sockets still exist:"
  echo "$ESCAPE_SOCKETS" | while read -r sock; do
    echo "         $sock"
  done
fi

# vscode-ipc and vscode-git sockets are cleaned up by a background loop in the
# Docker Compose command (10 passes at 30s intervals, ~5 min total).
# If the container started recently, they may still exist temporarily.
IPC_SOCKETS=$(find /tmp -maxdepth 2 \( -name 'vscode-ipc-*.sock' -o -name 'vscode-git-*.sock' \) 2>/dev/null || true)
if [ -z "$IPC_SOCKETS" ]; then
  pass "No vscode-ipc/git sockets found (cleanup loop successful)"
else
  IPC_COUNT=$(echo "$IPC_SOCKETS" | wc -l)
  # Check if the cleanup loop is still running (PID 1's bash with the for loop)
  CLEANUP_RUNNING=$(pgrep -f 'sleep 30' 2>/dev/null || true)
  if [ -n "$CLEANUP_RUNNING" ]; then
    warn "$IPC_COUNT vscode-ipc/git socket(s) exist (cleanup loop still running — will be removed within 5 min of container start)"
  else
    warn "$IPC_COUNT vscode-ipc/git socket(s) still exist after cleanup completed — check docker-compose.yml command"
  fi
fi

# ─── 3. Hardening Script ────────────────────────────────────────────────────

echo ""
echo "── Hardening Script ──"

if [ -f "$HOME/.config/security-harden.sh" ]; then
  pass "Security hardening script exists at ~/.config/security-harden.sh"
else
  fail "Security hardening script missing at ~/.config/security-harden.sh"
fi

BASHRC_LINE=$(head -1 ~/.bashrc 2>/dev/null || echo "")
if echo "$BASHRC_LINE" | grep -q 'security-harden.sh'; then
  pass ".bashrc sources hardening script on line 1 (before interactive guard)"
else
  fail ".bashrc does not source hardening script on line 1"
  info "Line 1 is: $BASHRC_LINE"
fi

# ─── 4. Privilege Escalation ────────────────────────────────────────────────

echo ""
echo "── Privilege Controls ──"

if command -v sudo &>/dev/null; then
  fail "sudo is installed (should be removed for security)"
else
  pass "sudo is not installed"
fi

if [ "$(whoami)" != "root" ]; then
  pass "Running as non-root user: $(whoami)"
else
  fail "Running as root!"
fi

# Check that all capabilities are dropped (cap_drop: ALL)
CAP_EFF=$(grep -oP '(?<=CapEff:\s).*' /proc/self/status 2>/dev/null || echo "unknown")
if [ "$CAP_EFF" = "0000000000000000" ]; then
  pass "All capabilities dropped (CapEff: $CAP_EFF)"
elif [ "$CAP_EFF" = "unknown" ]; then
  warn "Could not read capabilities from /proc/self/status"
else
  fail "Container has capabilities (CapEff: $CAP_EFF) — cap_drop: ALL not effective"
fi

# Check that no-new-privileges is enforced
NO_NEW_PRIVS=$(grep -oP '(?<=NoNewPrivs:\s).*' /proc/self/status 2>/dev/null || echo "unknown")
if [ "$NO_NEW_PRIVS" = "1" ]; then
  pass "no-new-privileges is enforced (NoNewPrivs: 1)"
elif [ "$NO_NEW_PRIVS" = "unknown" ]; then
  warn "Could not read NoNewPrivs from /proc/self/status"
else
  fail "no-new-privileges is NOT enforced (NoNewPrivs: $NO_NEW_PRIVS) — security_opt not effective"
fi

# ─── 5. Git Push ────────────────────────────────────────────────────────────

echo ""
echo "── Git Access ──"

if git log --oneline -1 &>/dev/null; then
  pass "git log works (read access)"
else
  warn "git log failed (may not be in a git repo)"
fi

# Check if SSH keys are accessible
if [ -z "${SSH_AUTH_SOCK:-}" ] || [ ! -S "${SSH_AUTH_SOCK:-/nonexistent}" ]; then
  pass "SSH agent not available (git push blocked)"
else
  fail "SSH agent is accessible at $SSH_AUTH_SOCK"
fi

# ─── 6. Docker Proxy ────────────────────────────────────────────────────────

echo ""
echo "── Docker Proxy ──"

if [ -n "${DOCKER_HOST:-}" ]; then
  info "DOCKER_HOST is set to: $DOCKER_HOST"

  if docker ps &>/dev/null; then
    pass "docker ps works (read access)"
  else
    warn "docker ps failed (proxy may not be running)"
  fi

  # Test that write operations are blocked
  if docker run --rm alpine echo "test" 2>/dev/null; then
    fail "docker run succeeded (should be blocked by proxy)"
  else
    pass "docker run is blocked"
  fi
else
  info "DOCKER_HOST not set (Docker proxy may not be configured)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "=========================================="
if [ $FAILURES -eq 0 ]; then
  echo -e " ${GREEN}All critical checks passed${NC}"
else
  echo -e " ${RED}$FAILURES critical check(s) FAILED${NC}"
fi
if [ $WARNINGS -gt 0 ]; then
  echo -e " ${YELLOW}$WARNINGS warning(s)${NC}"
fi
echo "=========================================="
echo ""

exit $FAILURES
