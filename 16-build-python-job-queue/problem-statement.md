# 16. BUILD: Containerise a Python job-queue stack from scratch (Hard)

## Situation

You've inherited a small Python service that has only ever run on a laptop with `uvicorn` and `celery` in two terminals. It is going to production next week, and there is no Dockerfile or Compose file yet. Write both.

```
app/
  db.py       # psycopg connection; reads DB_PASSWORD_FILE or DB_PASSWORD
  main.py     # FastAPI: GET /health, POST /jobs, GET /jobs/{id}
  worker.py   # Celery app `celery`, task `process(job_id)`
migrate.py    # creates the `jobs` table (idempotent), then exits
requirements.txt
```

Architecture:

```
             :8000
 client ──▶  api (FastAPI/uvicorn) ──▶ postgres
                 │                        ▲
                 └──▶ redis ──▶ worker ───┘
                                (celery)
 migrate: runs once before api/worker start
```

Environment variables the code reads: `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD_FILE` (or `DB_PASSWORD`), `REDIS_URL`.

## Requirements

### Dockerfile

1. **One image** is used by `api`, `worker`, and `migrate`. Only the command differs.
2. Multi-stage. Dependencies are installed in a builder stage. The final stage has no pip cache and no build tooling you added. Final image **< 350 MB**.
3. Dependency installation is cached: editing `app/main.py` must not reinstall packages.
4. Runs as a **non-root user with a fixed UID**.
5. Python logs appear in `docker compose logs` immediately (no buffering), and no `.pyc` files are written at runtime.
6. Exec-form `CMD`, so signals reach the process directly.
7. A `.dockerignore` keeps `.git`, virtualenvs, `__pycache__`, and **secrets** out of the build context.

### compose.yaml

8. Services: `db` (postgres:16), `redis` (redis:7), `migrate`, `api`, `worker`.
9. Only `api` is reachable from the host (port 8000). Postgres and Redis are **not** published.
10. The DB password is **not** in `compose.yaml`, `.env`, or the image. Use a Compose **secret** from `./secrets/db_password.txt`, shared by Postgres (`POSTGRES_PASSWORD_FILE`) and the app (`DB_PASSWORD_FILE`).
11. Startup order is guaranteed without any `sleep`:
    - `migrate` starts only after Postgres is **healthy**
    - `api` and `worker` start only after `migrate` **completed successfully** and Redis is healthy
12. `api` has its own healthcheck. The image has no `curl`, so don't install it just for this.
13. Postgres data survives `docker compose down` (but not `down -v`).
14. `worker` gets up to 60 s to finish in-flight tasks on `docker compose stop`.
15. Worker concurrency is configurable with `WORKER_CONCURRENCY` (default 2), without editing the file.
16. Don't repeat the shared app config (image, env, secrets) across three services.

## Acceptance test

```bash
mkdir -p secrets && openssl rand -hex 16 > secrets/db_password.txt
docker compose up -d --build --wait
docker compose ps -a                         # migrate Exited (0); api healthy; db/redis healthy
curl -X POST localhost:8000/jobs             # {"id":1,"status":"queued"}
sleep 3 && curl localhost:8000/jobs/1        # {"id":1,"status":"done"}
docker compose exec api id                   # uid=10001, not root
docker image ls                              # < 350 MB
nc -z localhost 5432 || echo "db not exposed: good"
touch app/main.py && docker compose build    # no pip install step re-runs
docker compose stop worker                   # logs show "Warm shutdown"
```

## Hint

- `condition: service_completed_successfully` exists.
- YAML anchors plus `x-` extension fields let you share config between services.
- Copy a virtualenv between stages.
- `python -c "import urllib.request; ..."` is a perfectly good healthcheck.

---

## Reference solution

### `.dockerignore`

```
.git
.venv
__pycache__/
*.pyc
secrets/
compose*.yaml
```

### `Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim AS builder
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

FROM python:3.12-slim
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
COPY app/ app/
COPY migrate.py .
USER 10001
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Why these choices:

- **venv copy.** Everything pip installed lives under `/opt/venv`, so one `COPY --from` moves it. If a dependency ever needs a compiler (`gcc`, `libpq-dev`), you add it to the builder stage only, and it never reaches the final image.
- **Cache mount** keeps pip's download cache between builds without storing it in a layer.
- `requirements.txt` is copied before the source, so code edits don't invalidate the install layer.

### `compose.yaml`

```yaml
x-app: &app
  build: .
  image: jobs-app:local
  environment:
    DB_HOST: db
    DB_NAME: app
    DB_USER: app
    DB_PASSWORD_FILE: /run/secrets/db_password
    REDIS_URL: redis://redis:6379/0
  secrets:
    - db_password
  restart: unless-stopped

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_DB: app
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 2s
      timeout: 3s
      retries: 20
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 20
    restart: unless-stopped

  migrate:
    <<: *app
    command: ["python", "migrate.py"]
    restart: "no"
    depends_on:
      db:
        condition: service_healthy

  api:
    <<: *app
    ports:
      - "8000:8000"
    depends_on:
      migrate:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 10s

  worker:
    <<: *app
    command: ["celery", "-A", "app.worker", "worker", "--loglevel=INFO", "--concurrency=${WORKER_CONCURRENCY:-2}"]
    stop_grace_period: 60s
    depends_on:
      migrate:
        condition: service_completed_successfully
      redis:
        condition: service_healthy

secrets:
  db_password:
    file: ./secrets/db_password.txt

volumes:
  pgdata:
```

Notes:

- **`build` + `image` in the anchor.** Compose builds `jobs-app:local` once and every service reuses it. If only one service has `build:`, the others try to **pull** `jobs-app:local` from Docker Hub and log errors.
- **`restart: "no"` on `migrate`.** It inherits `unless-stopped` from the anchor, and a restarting migration never counts as "completed".
- **Healthcheck and `/health`.** The api healthcheck runs a real `SELECT 1`, so "healthy" means the api can reach its DB, not just that the process is up.
- **Secret file permissions.** A file-based secret is bind-mounted with its host permissions. It must be readable by uid 10001 (e.g. `chmod 644`, or better, owned by a matching uid on the server). Add `secrets/` to `.gitignore`.
- **Signals.** Celery is PID 1 through exec form, so on `docker compose stop` it gets SIGTERM, finishes running tasks ("Warm shutdown"), and exits before the 60 s SIGKILL.

### Extra credit

- Add a `compose.override.yaml` for dev with `develop.watch` (sync `./app`, rebuild on `requirements.txt`) and `uvicorn --reload`.
- Scale workers with `docker compose up -d --scale worker=3`. Why can't you do the same for `api` as written?
- Add `read_only: true` + `tmpfs: [/tmp]` to the app services and check what breaks.
