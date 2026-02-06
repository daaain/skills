# Node.js + pnpm DevContainer Setup

Patterns for setting up Node.js development in a secured DevContainer.

## Dockerfile — Global Installation

Install Node.js and pnpm globally (as root) before switching to the non-root user. This is simpler and safer than userspace installation.

```dockerfile
FROM debian:trixie

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install system dependencies (sudo intentionally omitted for security)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    xz-utils \
    jq \
    vim \
    ripgrep \
    fd-find \
    docker-cli \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user with host UID/GID for file permission compatibility
ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID

RUN if getent group $USER_GID >/dev/null; then \
        useradd --uid $USER_UID --gid $USER_GID -m $USERNAME; \
    else \
        groupadd --gid $USER_GID $USERNAME && \
        useradd --uid $USER_UID --gid $USER_GID -m $USERNAME; \
    fi

RUN mkdir -p /app/node_modules && chown -R $USER_UID:$USER_GID /app

# Install Node.js — pin version via .nvmrc, detect architecture automatically
COPY .nvmrc /tmp/.nvmrc
RUN NODE_VERSION=$(cat /tmp/.nvmrc | tr -d '[:space:]') \
    && ARCH=$(uname -m | sed 's/x86_64/x64/' | sed 's/aarch64/arm64/') \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
    && rm /tmp/.nvmrc \
    && npm install -g pnpm@10.12.4

# Switch to non-root user
USER $USERNAME

# Set up shell environment
ENV SHELL=/bin/bash

# Security hardening (see SECURITY-HARDENING.md)
RUN mkdir -p /home/vscode/.config && cat << 'HARDEN' > /home/vscode/.config/security-harden.sh
unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE GIT_ASKPASS \
      VSCODE_GIT_ASKPASS_MAIN VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_EXTRA_ARGS \
      REMOTE_CONTAINERS_IPC REMOTE_CONTAINERS_SOCKETS REMOTE_CONTAINERS_DISPLAY_SOCK \
      WAYLAND_DISPLAY
export BROWSER= SSH_AUTH_SOCK= GPG_AGENT_INFO=
HARDEN

RUN sed -i '1i source ~/.config/security-harden.sh 2>/dev/null || true' ~/.bashrc \
    && sed -i '2i export PATH="$HOME/.local/bin:$PATH"' ~/.bashrc \
    && mkdir -p /home/vscode/.local/bin /home/vscode/.cache \
    /home/vscode/.local/share/pnpm/store /home/vscode/.local/share/pnpm/global

WORKDIR /app
CMD ["sleep", "infinity"]
```

### Why Debian instead of `node:lts`?

- Pin exact Node version via `.nvmrc` (single source of truth)
- Smaller image when you only install what you need
- Easier to add Playwright/Chromium system dependencies
- Works on both x64 and arm64 (Apple Silicon) without separate images

### Why global pnpm instead of userspace?

Userspace installation (`--prefix /home/vscode/.local`) adds complexity:
- Requires `chown` of the install directory
- Needs `PNPM_HOME` and extra PATH entries
- `pnpm config set global-bin-dir` at runtime

Global installation is simpler — pnpm goes into `/usr/local/bin/` alongside Node.

## Startup Command — Runtime Setup

Some things should happen at container start rather than build time, to stay fresh without rebuilding the image:

```yaml
command: >
  bash -c '. /home/vscode/.bashrc &&
  curl -fsSL https://claude.ai/install.sh | bash &&
  pnpm config set store-dir /home/vscode/.local/share/pnpm/store &&
  pnpm install;
  sleep infinity'
```

**Why at startup?**
- `claude` CLI — always get the latest version
- `pnpm install` — dependencies change frequently
- These run in the background while the IDE is already open

**Why `sleep infinity`?**
The container must stay running for VS Code to attach. The semicolon before `sleep` (not `&&`) ensures the container stays up even if setup fails.

## Volume Strategy

```yaml
volumes:
  # Workspace — host-mounted for live editing
  - ..:/app:cached

  # node_modules — isolated Docker volumes (not synced to host)
  # Prevents OS-specific native module issues and speeds up file I/O
  - node-modules:/app/node_modules

  # Shared pnpm store — mounted from host for cross-worktree cache hits
  - ${PNPM_STORE_PATH}:/home/vscode/.local/share/pnpm/store:cached
```

### Why Docker volumes for node_modules?

- **Performance**: Docker volumes are much faster than host-mounted directories (especially on macOS)
- **Isolation**: Native modules compiled for Linux won't conflict with macOS/Windows host
- **Per-worktree**: Named volumes (`claude-code-${WORKTREE_NAME}-node-modules`) keep each worktree's dependencies separate

### Why mount the pnpm store from host?

- Shared cache across all worktrees and the host
- Packages downloaded once are available everywhere
- pnpm's content-addressable store has built-in integrity verification

## Host UID/GID Matching

To avoid file permission issues between the container and host-mounted workspace:

```yaml
build:
  args:
    USER_UID: ${HOST_UID:-1000}
    USER_GID: ${HOST_GID:-1000}
```

Generate these in `initializeCommand` (runs on host):

```json
{
  "initializeCommand": "bash -c 'echo \"HOST_UID=$(id -u)\" > .devcontainer/.env && echo \"HOST_GID=$(id -g)\" >> .devcontainer/.env'"
}
```

## Locale Configuration

For proper Unicode handling (important for some npm packages and git):

```dockerfile
RUN apt-get install -y locales \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
    && locale-gen
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
```
