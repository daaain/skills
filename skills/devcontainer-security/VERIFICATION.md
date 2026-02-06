# Verifying Security Controls

## Automated Verification Script

Run the comprehensive check:

```bash
bash .claude/skills/devcontainer-security/scripts/verify-hardening.sh
```

This checks:
- VS Code escape vector env vars are cleared
- IPC socket files are deleted
- `sudo` is unavailable
- All Linux capabilities are dropped (`cap_drop: ALL`)
- No-new-privileges is enforced (`security_opt: no-new-privileges:true`)
- `git push` is blocked
- `docker run` / `docker exec` are blocked
- Read operations (`docker ps`, `git log`) still work

## Manual Verification

### Environment Variables

```bash
# All of these should return empty
echo "VSCODE_IPC_HOOK_CLI: '$VSCODE_IPC_HOOK_CLI'"
echo "BROWSER: '$BROWSER'"
echo "GIT_ASKPASS: '$GIT_ASKPASS'"
echo "VSCODE_GIT_IPC_HANDLE: '$VSCODE_GIT_IPC_HANDLE'"
echo "REMOTE_CONTAINERS_IPC: '$REMOTE_CONTAINERS_IPC'"
echo "SSH_AUTH_SOCK: '$SSH_AUTH_SOCK'"
```

### Socket Files

```bash
# Should return nothing (or only non-escape-vector sockets)
find /tmp -maxdepth 2 -name '*.sock' 2>/dev/null
```

Acceptable sockets (not escape vectors):
- `biome-socket-*` — Biome linter
- Sockets from your own services

Escape vector sockets that should NOT exist:
- `vscode-ssh-auth-*.sock` — deleted by `postStartCommand`
- `vscode-remote-containers-ipc-*.sock` — deleted by `postStartCommand`
- `vscode-ipc-*.sock` — deleted by background cleanup loop in Docker Compose `command` (10 passes at 30s intervals, ~5 min); may exist briefly after startup
- `vscode-git-*.sock` — deleted by background cleanup loop in Docker Compose `command` (10 passes at 30s intervals, ~5 min); may exist briefly after startup

### Container Hardening (Capabilities & Privileges)

```bash
# All capabilities should be dropped (CapEff all zeros)
grep CapEff /proc/self/status
# Expected: CapEff:	0000000000000000

# No-new-privileges should be enforced
grep NoNewPrivs /proc/self/status
# Expected: NoNewPrivs:	1
```

### Docker Proxy

```bash
# Should work (read-only)
docker ps

# Should fail with 403
docker run alpine echo "test"

# Should fail with 403
docker exec $(docker ps -q | head -1) echo "test"
```

### Git Push

```bash
# Should fail with SSH error
git push 2>&1 | head -5
```

### Sudo

```bash
# Should fail with "command not found"
sudo whoami
```

## Interpreting Results

The verification script uses colour-coded output:

- **PASS** (green) — Control is working as expected
- **FAIL** (red) — Control is not effective, investigate
- **WARN** (yellow) — Partial effectiveness, review context
- **INFO** (blue) — Informational, not a pass/fail check

### Common Warnings

**"vscode-ipc-*.sock sockets exist"**: If the container started within the last 5 minutes, the background cleanup loop in Docker Compose `command` may still be running (10 passes at 30s intervals, ~5 min total). Wait a few minutes and re-check — the sockets should be permanently deleted. If they persist after 5 minutes, check the `command` in `docker-compose.yml`.

**"REMOTE_CONTAINERS env var still set"**: VS Code may re-inject some variables. Check whether the hardening script is being sourced correctly:

```bash
# This should show the source line
head -1 ~/.bashrc
# Expected: source ~/.config/security-harden.sh 2>/dev/null || true
```

## Testing After Container Rebuild

After modifying the Dockerfile or devcontainer.json, rebuild and verify:

1. Rebuild: VS Code Command Palette → "Dev Containers: Rebuild Container"
2. Wait for startup to complete
3. Run verification script
4. Check that IDE features (IntelliSense, linting) still work
