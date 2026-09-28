# 6. Two stacks that can't find each other (Medium-Hard)

## Situation

The frontend and backend live in separate repos, each with its own `docker-compose.yml`. The frontend can't resolve `http://api:8000`. The backend also needs to call a license server running directly on the Linux host at port 9000. `host.docker.internal` works on Macs but not on the Linux server.

## Your task

Let the two stacks talk over service names without publishing the API port to the host, and make the host service reachable on Linux.

## Hint

Look at external networks and `extra_hosts` with `host-gateway`.

---

## Solution

### Why it fails

Each Compose project creates its **own** network (`<project>_default`). Containers in the `frontend` project cannot resolve service names from the `backend` project. Compose also prefixes service names for DNS aliases, so `api` only resolves inside its own project. And `host.docker.internal` is a Docker Desktop convenience that does not exist on Linux.

### Fix 1: a shared external network

Create it once:

```bash
docker network create app-net
```

**backend/docker-compose.yml**

```yaml
services:
  api:
    build: .
    expose:
      - "8000"          # visible to other containers, NOT published to the host
    networks:
      - app-net
    extra_hosts:
      - "host.docker.internal:host-gateway"
networks:
  app-net:
    external: true
```

**frontend/docker-compose.yml**

```yaml
services:
  web:
    build: .
    environment:
      API_URL: http://api:8000
    networks:
      - app-net
networks:
  app-net:
    external: true
```

Now `web` resolves `api` through Docker's embedded DNS because both attach to `app-net`.

### Fix 2: reach the host service on Linux

Add an explicit host-gateway mapping. This works on Linux Docker Engine 20.10+ (and is harmless/ignored on Desktop where the alias already exists):

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Then call the license server at `http://host.docker.internal:9000`. Alternatively, if the license server binds `0.0.0.0`, use the bridge gateway IP (usually `172.17.0.1` or the `app-net` gateway). `host-gateway` is preferred because it is portable and does not hard-code an IP.

### Important details

- **Do not publish the API port.** `expose` documents the port and makes it reachable on the shared network; it does not bind a host port. Avoid `ports: - "8000:8000"`.
- **Service name vs container name.** Compose adds a network alias equal to the service name (`api`). If you need a stable name across projects, set `container_name` or a network alias explicitly:
  ```yaml
  services:
    api:
      networks:
        app-net:
          aliases:
            - api
  ```
- **Network must exist before `up`.** `docker network create app-net` is idempotent-ish; wrap it in the deploy script or use an init compose file. An `external: true` network that is missing makes `compose up` fail with a clear error.
- **DNS across projects works both ways** as long as both are attached. There is no need to publish ports to the host.
- **Host gateway on Linux** requires the host firewall to allow the container subnet to reach port 9000; `ufw`/`iptables` rules are a common follow-up failure.

### Verify

```bash
docker compose -f backend/docker-compose.yml up -d
docker compose -f frontend/docker-compose.yml up -d

docker compose -f frontend/docker-compose.yml exec web \
  getent hosts api
docker compose -f frontend/docker-compose.yml exec web \
  wget -qO- http://api:8000/health

docker compose -f backend/docker-compose.yml exec api \
  wget -qO- http://host.docker.internal:9000/health
```