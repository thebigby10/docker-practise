# 8. The production disk is at 97% (Hard)

## Situation

A single VM running Compose alerts on disk usage. `/var/lib/docker` takes 180 GB of a 200 GB disk. The Postgres data volume lives on the same host and must not be touched.

## Your task

- Find exactly what's using the space (logs, images, build cache, volumes).
- Free space safely. List the commands you'd run and what each one removes.
- Stop it from happening again.

## Hint

Start with `docker system df -v`. Also check the size of the `*-json.log` files, and learn the difference between `prune` with and without `-a` and `--volumes`.

---

## Solution

### Step 1: measure before touching anything

```bash
docker system df          # summary: images, containers, volumes, build cache
docker system df -v       # per-object breakdown with SHARED and UNIQUE sizes

# where the bytes actually live on disk
sudo du -h --max-depth=1 /var/lib/docker | sort -h

# container logs are a classic hidden consumer
sudo du -h /var/lib/docker/containers/*/*-json.log | sort -h | tail
```

Read the output:

- **Images** — total vs `RECLAIMABLE`. Dangling (`<none>`) images are rebuild leftovers.
- **Containers** — stopped containers still hold their writable layer.
- **Local Volumes** — `docker system df -v` shows `LINKS`. `LINKS=0` means no container uses it. **This is where you must be careful: the Postgres volume will show `LINKS=1` while its container runs, but a stopped container can make it look unused.**
- **Build Cache** — BuildKit cache, often tens of GB on a busy CI/build host.

Also check the filesystem-level usage, not just Docker's accounting:

```bash
df -h /
sudo du -h --max-depth=2 /var/lib/docker/overlay2 | sort -h | tail
```

### Step 2: free space safely (in order of increasing risk)

```bash
# 1. Stopped containers only. Removes their writable layers. Safe.
docker container prune

# 2. Dangling images (untagged <none>). Does NOT remove tagged images. Safe.
docker image prune

# 3. Build cache. Safe to remove; only costs rebuild time.
docker builder prune

# 4. ALL unused images, including tagged ones not used by a container.
#    This WILL delete images you might want to keep (e.g. pinned rollback tags).
docker image prune -a

# 5. Unused volumes. DANGEROUS. Never run with --volumes until you have
#    confirmed the Postgres volume is in use or excluded.
docker volume prune
```

**Postgres protection, first line:** make sure its container is running (so `LINKS=1`) or, better, label the volume and prune by label:

```yaml
volumes:
  pgdata:
    labels:
      keep: "true"
```

```bash
# only remove volumes WITHOUT the keep label
docker volume prune --filter "label!=keep=true"
```

Even stronger: **never** run `docker system prune --volumes` on this host. `docker system prune -a --volumes` removes all unused images, all stopped containers, all build cache, and all unused volumes in one shot — the exact command that destroys a database when a container is briefly stopped.

### The prune matrix

| Command | Stopped containers | Dangling images | Tagged unused images | Build cache | Unused volumes |
|---|---|---|---|---|---|
| `docker container prune` | yes | – | – | – | – |
| `docker image prune` | – | yes | – | – | – |
| `docker image prune -a` | – | yes | yes | – | – |
| `docker builder prune` | – | – | – | yes | – |
| `docker system prune` | yes | yes | – | yes | – |
| `docker system prune -a` | yes | yes | yes | yes | – |
| `docker system prune -a --volumes` | yes | yes | yes | yes | **yes** |

The difference between `prune` and `prune -a` is tagged-but-unused images. `--volumes` is the one that can delete data.

### Step 3: cap container logs (often the real culprit)

Unbounded `json-file` logs are the most common cause of a slowly filling disk on a Compose host. Set per-service limits:

```yaml
services:
  app:
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Or globally in `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

Then restart Docker and, for existing containers, recreate them so the new logging config applies. Truncate existing logs without restarting:

```bash
sudo truncate -s 0 /var/lib/docker/containers/*/*-json.log
```

Truncating (not deleting) is important: the daemon holds the file descriptor, and deleting it leaves the space allocated until the container is recreated.

### Step 4: stop it recurring

1. **Log rotation** — global `max-size`/`max-file` as above.
2. **Scheduled cleanup** — a systemd timer or cron that runs the safe subset weekly:
   ```bash
   docker container prune -f
   docker image prune -f
   docker builder prune -f --keep-storage 20GB
   ```
   `--keep-storage` bounds the build cache instead of wiping it, so rebuilds stay fast.
3. **Image lifecycle** — delete old tags in the registry and on the host after each deploy; keep N-1 for rollback. `docker image prune -a` is safe *if* the deploy pulls images fresh and rollback tags are explicitly protected with labels.
4. **Separate the data from the ephemeral storage.** Put `/var/lib/docker` on its own volume, and ideally run Postgres on a dedicated volume/mount so Docker GC can never touch it. Even better: move Postgres off the Compose host entirely.
5. **Alert early** — monitor `docker system df` reclaimable space and disk usage at 70%, not 97%.
6. **Avoid `latest`-only workflows** where every deploy leaves a dangling image with no cleanup.

### Verify

```bash
df -h /
docker system df
# confirm the postgres volume is still present
docker volume ls | grep pgdata
docker compose exec db pg_isready
```

### Notes

- `docker system df -v` can be slow on a host with thousands of layers; it is still the right first look.
- The `overlay2` directory can contain space not attributable to any Docker object if the daemon crashed mid-write; `docker system prune` will not reclaim that. A daemon restart plus `docker system df` reconciles the accounting.
- Build cache can be pinned by `--keep-storage`; otherwise a single large multi-stage build can consume tens of GB.