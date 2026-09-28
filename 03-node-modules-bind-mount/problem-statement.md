# 3. `node_modules` vanishes in the dev setup (Medium)

## Situation

To get hot reload, a developer adds `./:/app` as a bind mount. Now the container fails with `Cannot find module 'express'`. On a Linux teammate's machine, files the app writes to `./uploads` end up owned by `root`, and he can't delete them without `sudo`.

```yaml
services:
  app:
    build: .
    volumes:
      - ./:/app
    command: npm run dev
```

## Your task

Fix both problems. Hot reload must keep working, and the fix must work on both macOS and Linux hosts.

## Hint

Mounts shadow what's in the image. Also look at which UID the process runs as.

---

## Solution

### Problem 1: the bind mount shadows `node_modules`

`./:/app` replaces the entire `/app` directory with the host directory. If the host has no `node_modules` (or a different platform's), the image's `node_modules` is hidden. Fix: keep the bind mount for source, but layer an **anonymous volume** over `/app/node_modules` so the image's copy survives.

### Problem 2: root-owned files on the host

The image's default user is `root` (UID 0). Files written to the bind mount are owned by root on Linux. Fix: run the container as the host user's UID/GID. On macOS Docker Desktop this is a no-op (file sharing maps ownership), on Linux it makes writes match the developer's account.

### Fixed `compose.yaml`

```yaml
services:
  app:
    build:
      context: .
      args:
        UID: ${UID:-1000}
        GID: ${GID:-1000}
    volumes:
      - ./:/app
      - /app/node_modules
    environment:
      NODE_ENV: development
      UPLOAD_DIR: /app/uploads
    user: "${UID:-1000}:${GID:-1000}"
    command: npm run dev
```

### Fixed `Dockerfile`

```dockerfile
FROM node:20-alpine
ARG UID=1000
ARG GID=1000
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN mkdir -p /app/uploads && chown -R ${UID}:${GID} /app

USER ${UID}:${GID}
EXPOSE 3000
CMD ["npm", "run", "dev"]
```

### Why this works on both platforms

- **Anonymous volume `/app/node_modules`**: Docker copies the image's `node_modules` into the volume on first creation and never lets the bind mount hide it. Host edits still hot-reload because only `node_modules` is isolated.
- **`user: ${UID}:${GID}`**: On Linux the process runs as the developer, so `uploads/` files are owned by them. On macOS the user namespace remapping in Docker Desktop means ownership is presented as the local user regardless; the setting is harmless.
- **`chown` in the image**: ensures the pre-created `uploads/` dir is writable by the non-root user even before the bind mount is considered.

### Gotchas

- `UID`/`GID` are not exported by default in every shell; export them (`export UID GID`) or pass explicitly: `UID=$(id -u) GID=$(id -g) docker compose up`.
- If the host already has a `node_modules` directory, delete it once so the anonymous volume is used; the bind mount would otherwise expose the host's stale copy only if the anonymous volume is removed.
- If the app creates directories at runtime, either pre-create them in the image or ensure the bind-mounted path is writable by the container user.
- To reset the anonymous volume after changing dependencies: `docker compose down -v` then `docker compose up --build`.