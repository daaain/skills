# Git Worktree Support

Run multiple git worktrees simultaneously, each with its own isolated dev container sharing infrastructure services.

## Why Worktrees?

Git worktrees let you check out multiple branches as separate directories. Combined with DevContainers, each worktree gets its own container with isolated node_modules, while sharing databases and other infrastructure.

```
project/                        # main worktree
project-feature-branch/         # git worktree add ../project-feature-branch feature-branch
project-bugfix/                 # git worktree add ../project-bugfix bugfix
```

## Architecture

```
┌─────────────────────────────────────────────┐
│          Shared Infrastructure              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ postgres │ │ emulator │ │   gcs    │    │
│  └──────────┘ └──────────┘ └──────────┘    │
│            Docker network: dev              │
└─────────────────────────────────────────────┘
        ↑               ↑              ↑
┌───────┴──────┐ ┌──────┴───────┐ ┌────┴────────┐
│ claude-code  │ │ claude-code  │ │ claude-code  │
│    -main     │ │  -feature    │ │   -bugfix    │
│  (worktree)  │ │  (worktree)  │ │  (worktree)  │
└──────────────┘ └──────────────┘ └─────────────┘
```

## Implementation

### 1. Dynamic Container Naming

The `initializeCommand` generates a `.env` file with the worktree name (runs on the host):

```json
{
  "initializeCommand": "bash -c 'mkdir -p .devcontainer && echo \"WORKTREE_NAME=$(basename \"$PWD\")\" > .devcontainer/.env && echo \"GIT_MAIN_REPO_PATH=$(realpath \"$(git rev-parse --git-common-dir 2>/dev/null)/..\" 2>/dev/null || echo \"$PWD\")\" >> .devcontainer/.env && echo \"LOCAL_WORKSPACE_FOLDER=$PWD\" >> .devcontainer/.env && echo \"HOST_HOME=$HOME\" >> .devcontainer/.env && echo \"HOST_UID=$(id -u)\" >> .devcontainer/.env && echo \"HOST_GID=$(id -g)\" >> .devcontainer/.env'"
}
```

This generates `.devcontainer/.env`:

```bash
WORKTREE_NAME=project-feature-branch
GIT_MAIN_REPO_PATH=/Users/you/code/project
LOCAL_WORKSPACE_FOLDER=/Users/you/code/project-feature-branch
HOST_HOME=/Users/you
HOST_UID=501
HOST_GID=20
```

### 2. Per-Worktree Container Names and Volumes

Use `${WORKTREE_NAME}` in docker-compose.yml for unique naming:

```yaml
services:
  app:
    container_name: claude-code-${WORKTREE_NAME:-default}
    volumes:
      - ..:/app:cached
      # Per-worktree isolated volumes
      - node-modules:/app/node_modules
    env_file:
      - .env  # The generated .env file

volumes:
  node-modules:
    name: claude-code-${WORKTREE_NAME:-default}-node-modules
```

Each worktree gets its own named volume, preventing conflicts.

### 3. Git Directory Mount

Git worktrees have a `.git` file (not directory) pointing to the main repo's `.git` directory. The container needs access to both:

```yaml
volumes:
  # Workspace (the worktree itself)
  - ..:/app:cached
  # Main repo's .git — mount to same absolute path for git to find it
  - ${GIT_MAIN_REPO_PATH}/.git:${GIT_MAIN_REPO_PATH}/.git:cached
```

**Why the same absolute path?** The worktree's `.git` file contains an absolute path like `gitdir: /Users/you/code/project/.git/worktrees/feature-branch`. If we mount `.git` to a different path, git won't find it.

### 4. Shared Network

All worktree containers join the same Docker network to access shared infrastructure:

```yaml
networks:
  dev:
    external: true  # Created by docker-compose.shared.yml or manually
```

Start shared infrastructure once:

```bash
docker compose -f docker-compose.shared.yml up -d
```

### 5. Platform-Specific pnpm Store Path

The `initializeCommand` can detect the OS and set the correct pnpm store path:

```bash
if [[ "$OSTYPE" == darwin* ]]; then
  PNPM_STORE="$HOME/Library/pnpm/store"
else
  PNPM_STORE="$HOME/.local/share/pnpm/store"
fi
echo "PNPM_STORE_PATH=$PNPM_STORE" >> .devcontainer/.env
```

Then in docker-compose.yml:

```yaml
volumes:
  - ${PNPM_STORE_PATH}:/home/vscode/.local/share/pnpm/store:cached
```

## Gitignore

Add to `.gitignore`:

```
.devcontainer/.env
.claude-docker/
```

## Precreating Mounted Files

Docker creates a directory on the host if a file mount target doesn't exist. Prevent this in `initializeCommand`:

```bash
mkdir -p .claude-docker
touch .claude-docker/.bash_history
[ -f .claude-docker/.claude.json ] || echo '{}' > .claude-docker/.claude.json
```

## Common Issues

### "fatal: not a git repository"

The `.git` directory mount path doesn't match the absolute path in the worktree's `.git` file. Ensure `GIT_MAIN_REPO_PATH` is correct and mounted to the same path.

### Volume conflicts between worktrees

If two worktrees share the same volume name (e.g. both called `node-modules`), they'll share state. Use `${WORKTREE_NAME}` in volume names to isolate them.

### Shared infrastructure not running

If the dev container can't reach `postgres` or other services, ensure the shared infrastructure is started and the network exists:

```bash
docker network ls | grep dev
docker compose -f docker-compose.shared.yml up -d
```
