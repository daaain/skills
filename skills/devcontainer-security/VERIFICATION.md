# Verifying Security Controls

## Integration Testing with devcontainers-cli

Test security hardening from the host **without opening VS Code**. This uses [`@devcontainers/cli`](https://github.com/devcontainers/cli) to build and start the container, then runs verification checks against it. Think of it as a TDD loop for container security: run tests, fix config, re-run until green.

### Prerequisites

- **Docker** with Compose v2 (`docker compose version`)
- **Node.js** with npx (for `@devcontainers/cli`)

### Quick Start

Run all checks with the automated test runner:

```bash
bash .claude/skills/devcontainer-security/scripts/run-integration-tests.sh /path/to/workspace
```

This outputs [TAP](https://testanything.org/) format — human-readable and machine-parseable. Exit 0 if all pass, exit 1 if any fail.

### Workflow (Step by Step)

If you need to run checks manually or debug failures, here's the full workflow.

**1. Build and start the container:**

```bash
npx @devcontainers/cli up --workspace-folder .
```

This outputs JSON. Extract the container ID:

```bash
CONTAINER_ID=$(npx @devcontainers/cli up --workspace-folder . 2>&1 \
  | grep -oP '"containerId"\s*:\s*"\K[^"]+' | head -1)
```

**2. Wait for docker proxy readiness:**

The docker-proxy service may take a few seconds to start. Retry until `docker ps` works:

```bash
for i in $(seq 1 15); do
  npx @devcontainers/cli exec --workspace-folder . docker ps &>/dev/null && break
  echo "Attempt $i — proxy not ready, retrying in 2s..."
  sleep 2
done
```

**3. Run verification checks:**

Use `npx @devcontainers/cli exec` for standard checks and `docker exec -e` for env var injection tests (see table below).

**4. Clean up:**

```bash
docker compose -f .devcontainer/docker-compose.yml down --volumes --remove-orphans
```

Always clean up, even on failure — the test runner script uses `trap EXIT` to handle this automatically.

### Individual Test Commands

| # | Test | Command | Pass |
| --- | ------ | ------- | ------ |
| 1 | Hardening script exists | `devcontainer exec ... test -f ~/.config/security-harden.sh` | exit 0 |
| 2 | .bashrc sources hardening on line 1 | `devcontainer exec ... head -1 ~/.bashrc` | contains `security-harden.sh` |
| 3 | Env vars cleared (with injection) | `docker exec -e VSCODE_IPC_HOOK_CLI=/tmp/fake <id> bash -lc 'echo "${VSCODE_IPC_HOOK_CLI:-}"'` | empty output |
| 4 | Agent vars set to empty | `docker exec -e SSH_AUTH_SOCK=/tmp/fake <id> bash -lc 'echo "${SSH_AUTH_SOCK}"'` | empty output |
| 5 | No sudo | `devcontainer exec ... command -v sudo` | exit non-zero |
| 6 | Non-root user | `devcontainer exec ... whoami` | not `root` |
| 7 | Capabilities dropped | `devcontainer exec ... grep CapEff /proc/self/status` | `0000000000000000` |
| 8 | No new privileges | `devcontainer exec ... grep NoNewPrivs /proc/self/status` | `1` |
| 9 | Docker read access | `devcontainer exec ... docker ps` | exit 0 |
| 10 | Docker write blocked | `devcontainer exec ... docker run alpine echo test` | exit non-zero |
| 11 | SSH agent unavailable | `devcontainer exec ... bash -c 'test -z "${SSH_AUTH_SOCK}" -o ! -S "${SSH_AUTH_SOCK:-/x}"'` | exit 0 |

Where `devcontainer exec ...` is shorthand for `npx @devcontainers/cli exec --workspace-folder .` and `<id>` is the container ID from step 1.

### Key Technique: Env Var Injection Testing

Tests 3 and 4 use `docker exec -e` to **inject fake values** simulating what VS Code does at runtime, then verify the hardening script clears them via `bash -lc` (login shell). This is much stronger than checking variables are absent in a bare container — that trivially passes without VS Code.

The pattern:

```bash
# Inject VSCODE_IPC_HOOK_CLI as VS Code would, then check it's cleared
docker exec -e VSCODE_IPC_HOOK_CLI=/tmp/fake "$CONTAINER_ID" \
  bash -lc 'echo "${VSCODE_IPC_HOOK_CLI:-}"'
# Expected: empty output (hardening script unsets it)
```

`bash -lc` triggers the login shell path: `~/.profile` → `~/.bashrc` → hardening script on line 1. If the hardening script works correctly, the injected value is cleared before the echo runs.

### What CLI Testing Doesn't Cover

Some security controls can only be verified inside a full VS Code session:

- **Socket file cleanup** — VS Code creates IPC sockets (`vscode-ipc-*.sock`, `vscode-git-*.sock`); the CLI doesn't, so the `postStartCommand` and background cleanup loop can't be tested this way
- **VS Code re-injection of env vars** — VS Code re-injects variables like `BROWSER` and `VSCODE_IPC_HOOK_CLI` when spawning processes; the CLI doesn't replicate this behaviour (tests 3–4 simulate it with `docker exec -e`)
- **`postStartCommand` execution** — the CLI runs `onCreateCommand` and `updateContentCommand` but `postStartCommand` and `postAttachCommand` timing differs from VS Code

For these, use the in-container verification script after opening the devcontainer in VS Code (see next section).

---

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
# Expected: CapEff:  0000000000000000

# No-new-privileges should be enforced
grep NoNewPrivs /proc/self/status
# Expected: NoNewPrivs:  1
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
