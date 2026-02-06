# VS Code IPC Security Hardening

VS Code's remote development model injects Unix sockets and environment variables into the container that can be abused for container escape. See [The Red Guild's research](https://blog.theredguild.org/leveraging-vscode-internals-to-escape-containers/) for background.

## Attack Surface

**Sockets** created in `/tmp` (and `/tmp/user/<uid>/`):

| Socket | Purpose | Attack Vector |
|--------|---------|---------------|
| `vscode-ssh-auth-*.sock` | SSH agent forwarding | Use host SSH keys |
| `vscode-ipc-*.sock` | CLI integration | Execute commands on host via `code` CLI |
| `vscode-remote-containers-ipc-*.sock` | Host-container RPC | Extension command execution |
| `vscode-git-*.sock` | Git extension IPC | Git credential access |

**Environment variables** pointing to these sockets and host-side helper scripts:

| Variable | Risk |
|----------|------|
| `VSCODE_IPC_HOOK_CLI` | Host command execution via `code` CLI |
| `VSCODE_GIT_IPC_HANDLE` | Git credential access via host |
| `GIT_ASKPASS` / `VSCODE_GIT_ASKPASS_*` | HTTPS Git credential leakage |
| `REMOTE_CONTAINERS_IPC` | Extension command execution |
| `REMOTE_CONTAINERS_SOCKETS` | Enumerates multiple escape vectors |
| `REMOTE_CONTAINERS_DISPLAY_SOCK` | GUI forwarding (low risk) |
| `BROWSER` | Host-side execution via `--openExternal` |
| `WAYLAND_DISPLAY` | GUI forwarding (low risk) |

## Three-Layer Defence

No single layer is sufficient. Together they cover each other's weaknesses.

### Layer 1 — `remoteEnv` in devcontainer.json

First line of defence. Set variables to `null` (unset) or `""` (empty).

```json
{
  "remoteEnv": {
    "SSH_AUTH_SOCK": "",
    "GPG_AGENT_INFO": "",
    "BROWSER": "",
    "VSCODE_IPC_HOOK_CLI": null,
    "VSCODE_GIT_IPC_HANDLE": null,
    "GIT_ASKPASS": null,
    "VSCODE_GIT_ASKPASS_MAIN": null,
    "VSCODE_GIT_ASKPASS_NODE": null,
    "VSCODE_GIT_ASKPASS_EXTRA_ARGS": null,
    "REMOTE_CONTAINERS_IPC": null,
    "REMOTE_CONTAINERS_SOCKETS": null,
    "REMOTE_CONTAINERS_DISPLAY_SOCK": null,
    "WAYLAND_DISPLAY": null
  }
}
```

**Limitation**: VS Code re-injects several of these (`BROWSER`, `VSCODE_IPC_HOOK_CLI`, `GIT_ASKPASS`) when spawning new processes. This layer alone is insufficient.

### Layer 2 — Shell Hardening Script (Primary Defence)

A script sourced from `.bashrc` that clears escape vector variables in every shell session.

**Critical subtlety**: Coding agents like Claude Code invoke bash as a **non-interactive login shell**. Bash sources `~/.profile` → `~/.bashrc`, but Debian's default `.bashrc` has an interactive guard:

```bash
case $- in
    *i*) ;;
      *) return;;  # <-- non-interactive shells exit here!
esac
```

The hardening script MUST be sourced **before** this guard (line 1 of `.bashrc`).

**Create the script in the Dockerfile:**

```dockerfile
RUN mkdir -p /home/vscode/.config && cat << 'HARDEN' > /home/vscode/.config/security-harden.sh
# VS Code IPC sockets — can execute commands on the host
unset VSCODE_IPC_HOOK_CLI

# VS Code Git extension IPC — credential access via host
unset VSCODE_GIT_IPC_HANDLE \
      GIT_ASKPASS \
      VSCODE_GIT_ASKPASS_MAIN \
      VSCODE_GIT_ASKPASS_NODE \
      VSCODE_GIT_ASKPASS_EXTRA_ARGS

# Remote Containers extension IPC — host command execution bridge
unset REMOTE_CONTAINERS_IPC \
      REMOTE_CONTAINERS_SOCKETS \
      REMOTE_CONTAINERS_DISPLAY_SOCK

# GUI forwarding (low risk but unnecessary)
unset WAYLAND_DISPLAY

# Browser helper — can trigger actions on host via --openExternal
# Set to empty rather than unset to prevent fallback to defaults
export BROWSER=

# Agent forwarding — set to empty to prevent fallback to default socket paths
export SSH_AUTH_SOCK=
export GPG_AGENT_INFO=
HARDEN

# Source it BEFORE the interactive guard in .bashrc
RUN sed -i '1i source ~/.config/security-harden.sh 2>/dev/null || true' ~/.bashrc
```

**Why `unset` vs `export VAR=`?**
- `unset` for IPC variables — nothing should try to use these
- `export VAR=` for `BROWSER`, `SSH_AUTH_SOCK`, `GPG_AGENT_INFO` — prevents tools falling back to default socket paths

### Layer 3 — Socket File Deletion (Defence in Depth)

Delete socket files so they can't be discovered via `find`. Two mechanisms handle different socket creation timings:

- `postStartCommand` in devcontainer.json — runs before VS Code attaches, catches early sockets (SSH auth, remote-containers)
- A background cleanup loop in the Docker Compose `command` — catches IPC and git sockets created during and after VS Code attach

```json
{
  // In devcontainer.json — postStartCommand catches early sockets
  "postStartCommand": "find /tmp -maxdepth 2 \\( -name 'vscode-ssh-auth-*.sock' -o -name 'vscode-remote-containers-ipc-*.sock' -o -name 'vscode-remote-containers-*.js' \\) -delete 2>/dev/null || true"
}
```

```yaml
# In docker-compose.yml — background loop catches IPC/git sockets.
# 10 passes at 30s intervals (~5 minutes) to catch all late-created sockets.
# Runs as a child of the container's own bash process, NOT a VS Code lifecycle command.
command: >
  bash -c '. /home/vscode/.bashrc &&
  curl -fsSL https://claude.ai/install.sh | bash &&
  pnpm config set store-dir /home/vscode/.local/share/pnpm/store &&
  pnpm install &&
  just platform-frontend playwright-ensure-browsers;
  (for i in 1 2 3 4 5 6 7 8 9 10; do sleep 30;
    find /tmp -maxdepth 2 \( -name "vscode-ipc-*.sock" -o -name "vscode-git-*.sock" \) -delete 2>/dev/null;
  done) &
  sleep infinity'
```

Note `-maxdepth 2` — VS Code also creates sockets in `/tmp/user/1000/`.

**Key discovery**: `vscode-ipc-*.sock` and `vscode-git-*.sock` are **not recreated after deletion** — the IDE continues to work without them. However, VS Code creates IPC sockets at multiple times during startup — some 60+ seconds after attach. A single cleanup pass misses these late-created sockets. The 10-pass approach (every 30s for ~5 minutes) ensures all sockets are caught regardless of when VS Code creates them.

**Why Docker Compose `command` instead of `postAttachCommand`?** VS Code's `postAttachCommand` is unreliable for background processes. VS Code appears to use cgroup-based cleanup that kills ALL processes spawned during lifecycle commands, regardless of `nohup`, `setsid`, double-fork, or other daemonisation techniques. The Docker Compose `command` runs as the container's own process tree, which is not subject to VS Code's lifecycle management.

## Docker Container Hardening

In addition to the VS Code IPC mitigations above, the container itself is hardened at the Docker level:

```yaml
claude-code:
  cap_drop:
    - ALL
  security_opt:
    - no-new-privileges:true
```

- **`cap_drop: [ALL]`** — Drops all Linux capabilities, reducing the kernel attack surface. The container only runs Node.js, git, and bash — none need special capabilities at runtime. If something breaks, specific capabilities can be added back with `cap_add`.
- **`no-new-privileges:true`** — Prevents privilege escalation via setuid/setgid binaries. Combined with removing sudo, this ensures no process in the container can gain elevated privileges.

Together with the existing controls (no sudo, non-root user), these form **Layer 1 hardening** — strengthening the container boundary itself.

## VS Code Settings to Disable

```json
{
  "customizations": {
    "vscode": {
      "settings": {
        "dev.containers.dockerCredentialHelper": false,
        "dev.containers.copyGitConfig": false
      }
    }
  }
}
```

- `dockerCredentialHelper: false` — prevents Docker credential injection
- `copyGitConfig: false` — prevents host git config (with credential helpers) leaking in

## Trade-offs

| Variable | When Cleared | What Breaks |
|----------|--------------|-------------|
| `SSH_AUTH_SOCK` | SSH tools can't find agent | Can't use host SSH keys (intended) |
| `GPG_AGENT_INFO` | GPG can't find agent | Can't sign with host GPG keys (intended) |
| `BROWSER` | `xdg-open`/`open` fail | Links won't open in host browser |
| `VSCODE_IPC_HOOK_CLI` | `code` command fails | Can't open files in VS Code from terminal |
| `GIT_ASKPASS` / `VSCODE_GIT_ASKPASS_*` | HTTPS credential helper disabled | No HTTPS git auth |
| `VSCODE_GIT_IPC_HANDLE` | Git extension IPC disabled | VS Code Git panel may lose some features |
| `REMOTE_CONTAINERS_*` | Extension IPC disabled | Minor feature loss |

## Remaining Risk

There is a window after container start (up to ~5 minutes while the 10 cleanup passes complete) where IPC sockets may temporarily exist. Each pass at 30s intervals removes any sockets that exist at that point, progressively closing the attack surface. During this window, a targeted attack could discover `vscode-ipc-*.sock` sockets via `find /tmp` and connect using VS Code's IPC protocol (HTTP POST over Unix socket with JSON payloads). After the final pass, the sockets are permanently removed. The env var clearing in Layer 2 ensures that standard tools and shell processes can never find these sockets regardless.

## Verification

Run the verification script to confirm hardening is effective:

```bash
bash .claude/skills/devcontainer-security/scripts/verify-hardening.sh
```

See [VERIFICATION.md](VERIFICATION.md) for details.
