# 2. A 1.8 GB image that rebuilds for 6 minutes (Medium)

## Situation

A Node.js API image is 1.8 GB. Changing one line of code triggers a full `npm install` on every build, and the build context upload alone takes 40 seconds.

```dockerfile
FROM node:20
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
CMD npm start
```

## Your task

Get the image under 200 MB, and make a code-only rebuild finish in under 15 seconds.

## Hint

Think about layer order, `.dockerignore`, multi-stage builds, and whether dev dependencies belong in the final image.

---

## Solution

Four independent problems, four fixes:

1. **`COPY . .` before `npm install`** invalidates the dependency layer on *every* code change. Copy the manifests first, install, then copy source.
2. **No `.dockerignore`** so `node_modules`, `.git`, build output, and logs are sent to the daemon (the 40 s upload) and can clobber image state.
3. **Single stage** keeps compilers, dev deps, and `node:20` (full Debian) in the runtime image. Use `node:20-alpine` and a multi-stage build.
4. **`npm install`** instead of `npm ci`, and dev dependencies installed in the runtime layer.

### `.dockerignore`

```
node_modules
npm-debug.log
.git
.gitignore
Dockerfile
.dockerignore
dist
build
coverage
*.md
.env*
```

### Multi-stage Dockerfile

```dockerfile
# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### Why the rebuild is now fast

The `COPY package.json package-lock.json` + `npm ci` layer is cached and only invalidated when the lockfile changes. A code-only change invalidates only the `COPY . .` / `RUN npm run build` layers. With BuildKit and a registry cache (`--cache-to type=registry` / `--cache-from type=registry` in CI) those are also reused when the base image is unchanged.

### Expected numbers

| Metric | Before | After |
|---|---|---|
| Image size | ~1.8 GB | ~120–160 MB |
| Context upload | ~40 s | < 1 s |
| Code-only rebuild | ~6 min | ~5–15 s |

### Notes

- `npm prune --omit=dev` after the build keeps the runtime `node_modules` clean; alternatively install production deps in the runtime stage from the lockfile.
- If native modules are used, make sure both stages are the same Alpine/musl base so the compiled `.node` binaries match.
- `USER node` is a free hardening win and does not affect size.