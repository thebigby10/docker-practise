# 11. Uploads fail with Permission denied on the Linux server (Medium)

## Situation

A small Flask service (Python) stores uploaded files in `/app/uploads` and keeps an SQLite index in `/app/data/app.db`. The Dockerfile follows the "don't run as root" advice from a security review.

On the staging Linux VM, both endpoints fail:

```
$ curl -F file=@report.pdf localhost:8000/upload
500 Internal Server Error

web-1  | PermissionError: [Errno 13] Permission denied: '/app/uploads/report.pdf'
web-1  | sqlite3.OperationalError: unable to open database file
```

A teammate on macOS says "uploads work for me, only the DB is broken". Someone suggests `chmod -R 777 /app` in the Dockerfile.

```dockerfile
RUN useradd --create-home appuser && mkdir -p /app/uploads /app/data
USER appuser
```

```yaml
volumes:
  - ./uploads:/app/uploads
  - appdata:/app/data
```

## Your task

1. Explain why the named volume and the bind mount fail for different reasons.
2. Explain why macOS behaves differently from Linux for the bind mount.
3. Fix it without `chmod 777` and without running as root. The fix must also work on a server where the volume **already exists**.

## Hint

Run `docker compose exec web sh -c 'id; ls -ld /app/data /app/uploads'`. Who owns the directory in the image when the named volume is created? Who creates `./uploads` on the host if it doesn't exist?

---

## Solution

### Bug 1: named volume inherits root ownership from the image

When Docker creates an **empty named volume** and mounts it on a path that exists in the image, it copies the image directory's contents *and ownership* into the volume. `mkdir -p /app/data` ran as root, so the volume is `root:root 755`. `appuser` can't create `app.db`.

This happens only once, when the volume is first created. After that the volume keeps whatever ownership it has, even if you fix the Dockerfile.

### Bug 2: bind mount uses the host's ownership

A bind mount is the host directory itself. Docker does not change its ownership.

- If `./uploads` doesn't exist, `dockerd` (root) creates it, so it's `root:root`.
- If it exists, it's owned by whoever created it (e.g. the `deploy` user, uid 1001).
- `useradd` gave `appuser` the first free uid, **1000**. It only works when the host owner happens to be uid 1000 too.

### Why macOS "works"

Docker Desktop shares host files into its Linux VM with virtiofs/gRPC FUSE, which makes bind-mounted files appear owned by whichever uid accesses them. Named volumes live inside the VM, so macOS still gets bug 1. That's why the teammate sees only the DB error.

### Fix

**Dockerfile:** pin the uid and create the directories owned by that user **before** `USER`:

```dockerfile
FROM python:3.12-slim
ARG APP_UID=10001
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN useradd --uid ${APP_UID} --no-create-home appuser \
 && install -d -o appuser -g appuser /app/uploads /app/data
COPY --chown=root:root . .
USER appuser
EXPOSE 8000
CMD ["gunicorn", "-b", "0.0.0.0:8000", "app:app"]
```

The source code stays root-owned and read-only to the app. Only the two data directories are writable.

**Host bind mount:** create it with the right owner as part of provisioning:

```bash
sudo install -d -o 10001 -g 10001 /srv/app/uploads
```

Alternatively, run the container as the host user with `user: "${UID}:${GID}"` in Compose. That works well for dev machines. In production, prefer a fixed service uid.

**Existing volume:** fixing the Dockerfile won't change a volume that already exists. Fix it once:

```bash
docker compose run --rm --user root web chown -R 10001:10001 /app/data
# or, dev only (DELETES DATA):
docker compose down -v
```

### Why not `chmod 777`?

It hides the ownership problem instead of fixing it. It also lets every process in the container, including an attacker's, write to the app's code. And it doesn't help with the bind mount, because files created in the image don't affect a host directory.

### Verify

```bash
docker compose down -v && docker compose up -d --build
curl -F file=@requirements.txt localhost:8000/upload   # {"saved": ...}
curl localhost:8000/uploads
docker compose exec web ls -ln /app                     # data/uploads owned by 10001
```

### Extra credit

- Mount the root filesystem read-only (`read_only: true`) and add `tmpfs: [/tmp]`. With that in place, only the two volumes can be written.
- Look up rootless Docker and user-namespace remapping (`userns-remap`), and how they change the uid the host sees.
