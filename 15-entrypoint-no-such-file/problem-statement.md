# 15. `exec docker-entrypoint.sh: no such file or directory`, but the file is right there (Hard)

## Situation

The `orders` service (Java 21) was moved from `eclipse-temurin:21-jre` to a slimmer `alpine:3.20` + `openjdk21-jre-headless` runtime to save ~60 MB. The same PR added a `docker-entrypoint.sh` wrapper, written by a teammate on Windows.

```
$ docker compose up
orders-1  | exec /usr/local/bin/docker-entrypoint.sh: no such file or directory
dependency failed to start: container orders-1 exited (255)
```

The file definitely exists:

```
$ docker run --rm --entrypoint ls orders -l /usr/local/bin
-rwxr-xr-x    1 root     root   171 docker-entrypoint.sh
```

A second teammate runs `dos2unix` on the script, rebuilds, and gets **the exact same error**.

After that is finally fixed, `orders` runs and logs `listening on :8080`. But `gateway` never starts, and `docker compose ps` shows `orders ... (unhealthy)` forever.

## Your task

1. Explain why the kernel says "no such file or directory" for a file that exists.
2. Explain why `dos2unix` alone didn't fix it.
3. Get `orders` healthy and `gateway` serving `curl localhost:8080/orders`, **without** going back to the bigger base image.
4. Make sure the CRLF problem can't come back from a Windows checkout.

## Hint

- `file docker-entrypoint.sh` and `head -1 docker-entrypoint.sh | od -c`
- Which binary does the `#!` line point to? Does it exist in `alpine:3.20`?
- `docker inspect --format '{{json .State.Health}}' <container>`

---

## Solution

### Why "no such file or directory"?

For `ENTRYPOINT ["docker-entrypoint.sh"]`, the kernel `execve()`s the script, reads the `#!` line, and then executes **the interpreter** named there. If *the interpreter* doesn't exist, `execve` returns `ENOENT`. runc reports that error against the script's path, which is what makes this so confusing. The script is fine. The file that's missing is the one in the first line.

### Bug 1: CRLF line endings

```
$ head -1 docker-entrypoint.sh | od -c
0000000   #   !   /   b   i   n   /   b   a   s   h  \r  \n
```

The interpreter the kernel looks for is literally `/bin/bash\r`. No such file.

### Bug 2: there is no bash on Alpine

This is why `dos2unix` wasn't enough. Once the `\r` is gone, the kernel looks for `/bin/bash`, and plain Alpine only ships BusyBox `sh`. Same error, different cause. (The old `eclipse-temurin` image is Ubuntu-based and has bash. That's why this never came up before the base image changed.)

The script doesn't use any bash-only features, so the right fix is POSIX `sh`, not `apk add bash`:

```sh
#!/bin/sh
set -eu

JAVA_OPTS="${JAVA_OPTS:--XX:MaxRAMPercentage=70}"
echo "starting orders with JAVA_OPTS=${JAVA_OPTS}"
exec java ${JAVA_OPTS} -jar /app/app.jar "$@"
```

(`pipefail` was dropped because there are no pipes. BusyBox ash does support it if you need it later.) Keep the `exec`: without it, `sh` stays PID 1 and `java` never receives SIGTERM (see problem 5).

### Bug 3: the healthcheck calls a binary that isn't there

```
$ docker inspect --format '{{(index .State.Health.Log 0).Output}}' orders-1
exec: "curl": executable file not found in $PATH
```

A healthcheck whose command can't run counts as **failing**. `gateway` waits on `condition: service_healthy` forever. Alpine has BusyBox `wget`, so use it and point it at `127.0.0.1`. `localhost` can resolve to `::1` first in some containers, while the app may only listen on IPv4:

```yaml
healthcheck:
  test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:8080/health"]
  interval: 5s
  timeout: 3s
  retries: 5
  start_period: 10s
```

### Make it stay fixed

`.gitattributes` at the repo root forces LF for scripts on every checkout, whatever `core.autocrlf` is set to on Windows:

```
*.sh      text eol=lf
Dockerfile text eol=lf
```

Then re-normalize once: `git add --renormalize . && git commit`.

As an extra layer of protection, have the Dockerfile strip CRs:

```dockerfile
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh
```

### Verify

```bash
file docker-entrypoint.sh                 # no "with CRLF line terminators"
docker compose up -d --build --wait       # orders (healthy), gateway started
curl localhost:8080/orders                # [{"id":1,"total":42.0}]
```

### Same symptom, other causes (worth knowing)

- A binary built for glibc run on Alpine (musl): the missing file is the **dynamic loader** `/lib64/ld-linux-x86-64.so.2`. Check with `ldd` or `file`.
- An image for the wrong CPU architecture usually gives `exec format error` instead. Check with `docker image inspect --format '{{.Architecture}}'`.
