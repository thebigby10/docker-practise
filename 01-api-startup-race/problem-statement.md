# 1. The API crashes on every fresh start (Medium)

## Situation

After `docker compose up`, the API container exits with:

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

Running `docker compose restart api` a few seconds later makes it work.

```yaml
services:
  api:
    build: .
    environment:
      DATABASE_URL: postgres://app:secret@localhost:5432/app
    depends_on:
      - db
  db:
    image: postgres:16
```

## Your task

Make `docker compose up` work reliably on a clean machine without adding `sleep` anywhere.

## Hint

There are two separate bugs here. `depends_on` only waits for the container to *start*, not for Postgres to be ready.

---

## Solution

### Bug 1: wrong hostname

`localhost` inside the `api` container refers to the container itself, not the `db` container. Use the Compose service name `db`, which Docker's embedded DNS resolves.

```
DATABASE_URL: postgres://app:secret@db:5432/app
```

### Bug 2: readiness race

`depends_on` (short syntax) waits only for the container process to be *created/started*. Postgres then spends several seconds initializing before it accepts TCP connections. Two correct fixes:

**Option A (recommended): healthcheck + `condition: service_healthy`.**

```yaml
services:
  api:
    build: .
    environment:
      DATABASE_URL: postgres://app:secret@db:5432/app
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: app
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 2s
      timeout: 3s
      retries: 15
      start_period: 5s
```

**Option B: retry with backoff in the app.** This is the more robust production answer because a restart of Postgres mid-life is also handled. `compose.yaml` (fixed) and `app/db.js` show a retry loop.

### Why not `sleep`?

Sleep is a race in disguise: too short on a slow machine, wasted time on a fast one. A healthcheck is a readiness signal; a retry loop is a resilience signal. Use one (or both).

### Verify

```bash
docker compose down -v
docker compose up --build
# api should connect without any manual restart
```

### Extra credit

Add `restart: unless-stopped` to both services and a `depends_on` on `db` for any worker containers. Consider a `pg_isready`-based `start_period` that reflects real init time on first boot (volume creation is slower than subsequent starts).