# Docker Socket Proxy and Sibling Containers

## The Problem

Direct Docker socket access allows trivial container escape:

```bash
docker run -it --privileged --pid=host -v /:/host alpine chroot /host
```

That's complete host access in one command.

## Solution: Docker Socket Proxy

[Tecnativa docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) intercepts Docker API calls and blocks dangerous operations.

```yaml
services:
  docker-proxy:
    image: tecnativa/docker-socket-proxy:latest
    environment:
      # Read-only operations - allowed
      CONTAINERS: 1    # docker ps, logs, inspect
      IMAGES: 1        # docker images
      INFO: 1          # docker info
      NETWORKS: 1      # docker network ls
      VOLUMES: 1       # docker volume ls
      # Dangerous operations - blocked
      POST: 0          # No creating containers
      BUILD: 0         # No building images
      COMMIT: 0        # No committing containers
      EXEC: 0          # No exec into containers
      SWARM: 0         # No swarm operations
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - dev
```

The dev container connects via the proxy, not the socket directly:

```yaml
  app:
    environment:
      DOCKER_HOST: tcp://docker-proxy:2375
    depends_on:
      - docker-proxy
```

**What the agent can do**: `docker ps`, `docker logs`, `docker inspect`

**What the agent cannot do**: `docker run`, `docker exec`, `docker build`

## Why Keep Docker Access?

Being able to view logs of sibling containers (databases, emulators) is genuinely useful for debugging. The proxy preserves this while blocking escape vectors.

## Sibling Container Communication

Dev containers can communicate with sibling services over a shared Docker network. This is how you give the agent access to databases, emulators, etc. without mounting the Docker socket directly.

### Shared Infrastructure Pattern

For teams using multiple worktrees or wanting to share infrastructure:

**`docker-compose.shared.yml`** (started separately, runs once):

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: password
      POSTGRES_DB: myapp-db
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - dev

  # Add other shared services: Redis, emulators, etc.

networks:
  dev:
    name: dev

volumes:
  pgdata:
```

**`.devcontainer/docker-compose.yml`** (per worktree):

```yaml
services:
  docker-proxy:
    # ... (as above)
    networks:
      - dev

  app:
    build:
      context: ..
      dockerfile: .devcontainer/Dockerfile
    volumes:
      - ..:/app:cached
    environment:
      DOCKER_HOST: tcp://docker-proxy:2375
      DATABASE_URL: postgresql://postgres:password@postgres:5432/myapp-db
    networks:
      - dev
    depends_on:
      - docker-proxy
    command: sleep infinity

networks:
  dev:
    external: true  # Created by docker-compose.shared.yml
```

Key points:
- The shared network (`dev`) must be created first (either by starting shared services or `docker network create dev`)
- Use container hostnames (e.g. `postgres`) not `localhost` for service connections
- Each worktree's dev container joins the same network, accessing the same shared services

### Triggering Actions in Sibling Containers

With `EXEC: 0`, `docker exec` is blocked. If the agent needs to trigger actions in other containers, expose HTTP endpoints:

```yaml
  db-admin:
    image: your-db-admin
    networks:
      - dev
    # Exposes HTTP endpoints for backup, migration, etc.
```

This is better design anyway — explicit, logged, and rate-limitable.

### Localhost Proxy for Auth Callbacks

If your app uses OAuth callbacks that require `localhost`, you can proxy ports from the dev container to the app container:

```yaml
  localhost-proxy:
    image: alpine/socat
    network_mode: "service:app"
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        APP_HOST="${APP_CONTAINER_NAME:-app}"
        for port in 3000 3001 3002 3003; do
          socat TCP-LISTEN:$$port,fork,reuseaddr TCP:$$APP_HOST:3000 &
        done
        wait
    restart: unless-stopped
    depends_on:
      - app
```

## No Sudo

The Dockerfile should NOT install sudo:

```dockerfile
# Install tools (sudo intentionally omitted for security)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git vim ripgrep docker-cli \
    && rm -rf /var/lib/apt/lists/*
```

If the agent needs a tool, add it to the Dockerfile rather than giving it sudo access.

## No SSH Keys

Don't mount `~/.ssh` into the container. This blocks `git push` and prevents SSH key abuse:

```yaml
volumes:
  # Workspace
  - ..:/app:cached
  # Agent config only (no ~/.ssh mount!)
  - ../.claude-docker/.claude.json:/home/vscode/.claude.json
```

The agent can still use all local git operations (`commit`, `branch`, `stash`, etc.) — it just can't push to remotes.
