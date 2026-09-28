# 4. A leaked token in a public image (Medium)

## Situation

The app installs packages from a private npm registry. The Dockerfile does this:

```dockerfile
ARG NPM_TOKEN
RUN echo "//registry.company.com/:_authToken=${NPM_TOKEN}" > .npmrc && \
    npm ci && rm .npmrc
```

A security scan flags the pushed image, even though `.npmrc` is deleted.

## Your task

Show *where* the token can still be recovered from the image, then rewrite the build so the token never lands in any layer or in the image metadata.

## Hint

Run `docker history --no-trunc`. Then look at BuildKit's `--mount=type=secret`.

---

## Solution

### Where the token leaks

There are two leaks, and deleting `.npmrc` fixes neither:

1. **Layer history.** Each `RUN` creates an immutable layer. `rm .npmrc` runs in the *same* layer, so the final filesystem of that layer no longer has the file — but the layer's diff still contains the file that was written earlier in that instruction. `docker history --no-trunc` prints the full `RUN` command, which includes `ARG NPM_TOKEN` interpolation only if it was baked into the command string; the more reliable recovery is exporting the layer tarball.
2. **Build args are recorded in image config.** `ARG` values that are consumed are stored in the image history/config. `docker inspect` and `docker history --no-trunc` expose them. A build arg is *not* a secret.

Demonstrate:

```bash
docker history --no-trunc myimage:latest
docker inspect myimage:latest --format '{{json .Config.Env}}'

# recover the deleted .npmrc from the layer that created it
docker save myimage:latest -o img.tar
mkdir layers && tar -xf img.tar -C layers
# find the layer whose diff contains .npmrc
for d in layers/blobs/sha256/*; do tar -tf "$d" 2>/dev/null | grep -q '\.npmrc' && echo "leaked in $d"; done
tar -xOf <layer> app/.npmrc   # prints the token
```

### Fixed build (BuildKit secret)

The token is mounted at `/run/secrets/` only for the duration of the `RUN`, is never written into a layer, and is not recorded in the image config.

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npm_token,required=true \
    NPM_TOKEN="$(cat /run/secrets/npm_token)" \
    npm ci
```

If the registry needs `.npmrc` on disk during the install, write it to a path that is deleted in a *separate* step or, better, keep it off disk entirely using npm config via environment:

```dockerfile
RUN --mount=type=secret,id=npm_token,required=true \
    npm config set //registry.company.com/:_authToken "$(cat /run/secrets/npm_token)" && \
    npm ci && \
    npm config delete //registry.company.com/:_authToken
```

Because the config write and delete happen inside the same `RUN`, the secret never appears in the image filesystem. It is not an `ARG`, so it is not in the config either.

### Build invocation

```bash
# CLI
DOCKER_BUILDKIT=1 docker build \
  --secret id=npm_token,src="$HOME/.npmrc.token" \
  -t myimage:latest .

# Compose
docker compose build   # with the secrets block below
```

```yaml
services:
  api:
    build:
      context: .
      secrets:
        - npm_token
secrets:
  npm_token:
    file: ${HOME}/.npmrc.token
```

### Verification

```bash
docker history --no-trunc myimage:latest | grep -i token   # no match
docker inspect myimage:latest --format '{{json .Config.Env}}' | grep -i token  # no match
# scan all layers for the secret value
docker save myimage:latest | tar -xO 2>/dev/null | grep -c 'THE_ACTUAL_TOKEN'  # 0
```

### Notes

- Never pass secrets via `ARG` or `ENV`. `ENV` is visible in `docker inspect` and in `docker run` output.
- If you must support old Docker without BuildKit secrets, use a bind mount of the host `.npmrc` and `npm ci` in the same layer, but the secret then exists on the build host — BuildKit secrets are strictly better.
- Rotate the leaked token immediately; removing it from the image does not undo the exposure. Also check the registry's access logs.