# 9. 502s for 30 seconds after every deploy (Hard)

## Situation

nginx runs in Compose and proxies to `app:3000`. The deploy script runs `docker compose pull && docker compose up -d`. For roughly 10 seconds users get 502s while the new container starts. After that, nginx *keeps* returning 502s until someone restarts nginx, even though the new app container is healthy.

## Your task

Explain both failure phases, then design a near-zero-downtime deploy on a single host with Compose. Kubernetes and Swarm are not allowed.

## Hint

nginx resolves `proxy_pass` hostnames once at startup. Look into Docker's embedded DNS (`127.0.0.11`), healthchecks, and running old and new containers side by side.

---

## Solution

### Phase 1: the ~10 s of 502s while the new container starts

`docker compose up -d` stops the old container and starts the new one. Between "old is gone" and "new is accepting connections" there is no backend, so nginx gets connection refused → 502. The container's `Starting` state is not readiness.

### Phase 2: permanent 502s after the new container is healthy

nginx resolves `proxy_pass http://app:3000` **once at configuration load time** using the system resolver (`/etc/resolv.conf` → Docker's embedded DNS at `127.0.0.11`). When the container is recreated it gets a **new IP** on the Compose network. nginx keeps dialing the old IP, which no longer exists → 502 forever. The app is healthy, but nginx is stuck.

### Fix Phase 2: make nginx re-resolve

Two standard approaches.

**A. Variable in `proxy_pass` + a resolver.** Using a variable forces nginx to resolve at request time, and `resolver` points at Docker's embedded DNS:

```nginx
server {
    listen 80;
    resolver 127.0.0.11 valid=10s ipv6=off;

    location / {
        set $backend "http://app:3000";
        proxy_pass $backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_next_upstream error timeout http_502;
    }
}
```

With `valid=10s`, nginx re-resolves `app` every 10 s, so a recreated container is picked up within ~10 s. Combine with Phase 1 fix below to avoid even that window.

**B. Upstream with a shared DNS name.** Same idea, but keep an upstream block and re-resolve via a sidecar (e.g. `nginx-proxy`/`docker-gen`) that rewrites config and reloads nginx on container changes. More moving parts.

### Fix Phase 1: blue-green on a single host

Run old and new side by side and switch traffic only after the new one is healthy.

1. **Give each release its own service name/scale.** Compose can't run two versions of the same service with one name, so use two services: `app_blue` and `app_green`, both on the same network, and have nginx point at a single stable alias.

2. **Use a stable network alias.** Both `app_blue` and `app_green` declare the alias `app` on the shared network. The DNS name `app` then resolves to whichever containers are up. nginx (with the resolver fix) picks up the change.

```yaml
services:
  app_blue:
    image: registry/app:${BLUE_TAG}
    networks:
      appnet:
        aliases:
          - app
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
  app_green:
    image: registry/app:${GREEN_TAG}
    networks:
      appnet:
        aliases:
          - app
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
  nginx:
    image: nginx:1.25-alpine
    ports: ["80:80"]
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    networks:
      - appnet
networks:
  appnet:
```

3. **Deploy procedure** (no Kubernetes, no Swarm):

```bash
# current live = blue, deploy green
docker compose pull app_green
docker compose up -d --no-deps app_green

# wait until healthy
until [ "$(docker inspect -f '{{.State.Health.Status}}' $(docker compose ps -q app_green))" = "healthy" ]; do
  sleep 1
done

# now stop blue; nginx already re-resolved to include green
docker compose stop app_blue
```

During the switch both containers are up and answer to `app`; DNS returns both IPs and nginx round-robins. Once green is healthy, stopping blue leaves green serving. There is no window with zero backends.

4. **Optional but better: make nginx switch explicitly.** Keep `app` pointing only at the live color by using two aliases (`app-blue`, `app-green`) and an nginx `upstream` with `server app-green:3000;`. Reload nginx (`nginx -s reload` or `docker compose exec nginx nginx -s reload`) only after green is healthy. Reload is graceful and does not drop connections. This avoids relying on round-robin across colors.

5. **Drain.** Give in-flight requests a moment before stopping the old color:
   ```bash
   docker compose stop -t 30 app_blue
   ```
   and have the app handle SIGTERM (see scenario 5) so it finishes in-flight requests.

### Why not just `--wait`?

`docker compose up -d --wait` waits for healthchecks, which fixes *readiness* but not the nginx DNS staleness. You still need the resolver fix (or a reload) for Phase 2.

### Complete minimal deploy script

```bash
#!/usr/bin/env bash
set -euo pipefail

# determine current live color (default blue)
LIVE=$(cat .live_color 2>/dev/null || echo blue)
if [ "$LIVE" = blue ]; then NEXT=green; else NEXT=blue; fi

export "${NEXT^^}_TAG=$(git rev-parse --short HEAD)"

docker compose pull "app_$NEXT"
docker compose up -d --no-deps "app_$NEXT"

# wait for healthy
cid=$(docker compose ps -q "app_$NEXT")
for i in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$cid")
  [ "$status" = healthy ] && break
  [ "$i" = 60 ] && { echo "new container never became healthy"; exit 1; }
  sleep 2
done

# switch nginx upstream and reload (graceful)
sed -i "s/server app-.*:3000;/server app-$NEXT:3000;/" nginx-upstream.conf
docker compose exec nginx nginx -s reload

# drain and stop the old color
docker compose stop -t 30 "app_$LIVE"
echo "$NEXT" > .live_color
```

### Verify

```bash
# hammer nginx while deploying; expect zero non-200s
while true; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost/; sleep 0.1; done &
./deploy.sh
```

### Notes

- The permanent 502 is the tell-tale of nginx caching a DNS result. Any time you recreate a container behind nginx, either use the `resolver` + variable trick or reload nginx.
- `resolver 127.0.0.11 valid=10s` still leaves up to a 10 s stale window; the blue-green switch plus an explicit reload removes it.
- Docker's embedded DNS returns multiple A records for a name with multiple containers; nginx round-robins across them. Use that deliberately, not accidentally.
- Keep the old color running until the new one has served traffic successfully; a one-line `docker compose stop` is your rollback.