# 17. BUILD: Containerise a Spring Boot + Vite web app behind nginx (Medium–Hard)

## Situation

The "notes" app has a Spring Boot 3 backend (Java 21, Maven, JDBC + Postgres) and a Vite frontend (plain JS). Developers run it with `mvn spring-boot:run` and `npm run dev`. Ops wants a single `docker compose up` that works on any server. Write every Dockerfile, the nginx config, and the Compose file.

```
backend/
  pom.xml                          # spring-boot-starter-parent 3.3.4, <finalName>notes</finalName>
  src/main/java/.../NotesApplication.java   # GET/POST /api/notes
  src/main/resources/application.properties # reads DB_HOST, DB_NAME, DB_USER, DB_PASSWORD
  src/main/resources/schema.sql             # auto-applied on startup
frontend/
  package.json  index.html  src/main.js     # calls fetch('/api/notes'): a RELATIVE url
```

Target architecture:

```
browser ──:8080──▶ web (nginx: static files + /api proxy) ──▶ backend:8080 ──▶ db:5432
                   the only published port                    (not published)   (not published)
```

Actuator is enabled: `/actuator/health/readiness` returns `{"status":"UP"}` once the app can serve traffic.

## Requirements

### backend/Dockerfile

1. Multi-stage: build with Maven + JDK, run on a **JRE only** image.
2. Maven dependencies are cached. A Java-only change must not re-download dependencies.
3. The fat jar is split into **layers** so a code change produces a small (KB, not MB) top layer.
4. Runs as a non-root user with a fixed UID.
5. The JVM sizes its heap from the **container** memory limit, and dies fast (instead of thrashing) on heap OOM.

### frontend/Dockerfile + nginx.conf

6. Multi-stage: build with Node, serve the static `dist/` with nginx. Node and `node_modules` are not in the final image.
7. nginx runs **non-root** (so it can't listen on port 80 inside the container).
8. `/api/*` is reverse-proxied to the backend, so the browser sees a single origin and needs no CORS.
9. SPA deep links (`/anything`) return `index.html`, not 404.
10. Vite's hashed files under `/assets/` get long-lived immutable cache headers.

### compose.yaml

11. Only `web` is published on the host (`8080`).
12. `DB_PASSWORD` comes from `.env` and is **required**: `docker compose up` must fail with a clear message if it's missing.
13. Startup order without `sleep`: `db` healthy → `backend` healthy (actuator readiness) → `web`.
14. The backend healthcheck must work **without installing curl or wget** in the JRE image.
15. The backend is capped at 768 MB of memory.
16. Postgres data persists in a named volume.
17. Every service restarts automatically unless you stop it.

Also add a `.dockerignore` to each build context.

## Acceptance test

```bash
docker compose config >/dev/null                  # without .env: must fail with your message
echo 'DB_PASSWORD=change-me' > .env
docker compose up -d --build --wait
docker compose ps                                 # db, backend healthy; web up
curl -X POST -H 'Content-Type: application/json' -d '{"body":"hello"}' localhost:8080/api/notes
curl localhost:8080/api/notes                     # [{"id":1,"body":"hello"}]
curl -o /dev/null -w '%{http_code}\n' localhost:8080/some/deep/link   # 200
curl -sI localhost:8080/assets/$(ls frontend/dist/assets 2>/dev/null | head -1) | grep -i cache-control
docker compose exec backend id                    # not root
docker compose exec web id                        # not root
docker history <backend image>                    # top app layer is KB-sized
```

## Hint

- Spring Boot 3.3+: `java -Djarmode=tools -jar app.jar extract --layers --launcher`. The launcher class is `org.springframework.boot.loader.launch.JarLauncher`.
- `nginxinc/nginx-unprivileged` listens on 8080.
- `${VAR:?message}` in Compose.
- `eclipse-temurin:21-jre` is Ubuntu-based, so it has `bash`, and bash can open TCP sockets through `/dev/tcp`.

---

## Reference solution

### `backend/.dockerignore`

```
target/
.git
.idea
*.iml
```

### `backend/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -B -q dependency:go-offline
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -B -q package -DskipTests \
 && java -Djarmode=tools -jar target/notes.jar extract --layers --launcher --destination /extracted

FROM eclipse-temurin:21-jre
RUN useradd --uid 10001 --no-create-home app
WORKDIR /app
# least -> most frequently changing, so a code change only rebuilds the last layer
COPY --from=build /extracted/dependencies/ ./
COPY --from=build /extracted/spring-boot-loader/ ./
COPY --from=build /extracted/snapshot-dependencies/ ./
COPY --from=build /extracted/application/ ./
USER 10001
EXPOSE 8080
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
```

Resulting layers (`docker history`): dependencies ~25 MB, loader ~600 KB, **application ~37 KB**. A code push only uploads the 37 KB layer.

### `frontend/.dockerignore`

```
node_modules/
dist/
.git
```

### `frontend/nginx.conf`

```nginx
server {
    listen 8080;
    root /usr/share/nginx/html;

    location /api/ {
        proxy_pass http://backend:8080;          # no trailing slash: keep the /api prefix
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Compare this with problem 14: there the API routes had no `/api` prefix, so `proxy_pass` needed a trailing slash to strip it. Here the Spring controller is mapped at `/api/notes`, so the prefix must be **kept**.

### `frontend/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /src
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm install
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 8080
```

(Commit a `package-lock.json` and switch to `npm ci` for reproducible builds.)

### `compose.yaml`

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: notes
      POSTGRES_DB: notes
      POSTGRES_PASSWORD: ${DB_PASSWORD:?set DB_PASSWORD in .env}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U notes -d notes"]
      interval: 2s
      timeout: 3s
      retries: 20
    restart: unless-stopped

  backend:
    build: ./backend
    environment:
      DB_HOST: db
      DB_NAME: notes
      DB_USER: notes
      DB_PASSWORD: ${DB_PASSWORD:?set DB_PASSWORD in .env}
    mem_limit: 768m
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      # the JRE image has no curl; bash's /dev/tcp is enough for an HTTP/1.0 probe
      test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /actuator/health/readiness HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q UP <&3"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 30s
    restart: unless-stopped

  web:
    build: ./frontend
    ports:
      - "8080:8080"
    depends_on:
      backend:
        condition: service_healthy
    restart: unless-stopped

volumes:
  pgdata:
```

Why these choices:

- **`web` waits for `backend` healthy.** nginx resolves `proxy_pass` hostnames at **startup**. If the backend container doesn't exist yet, nginx exits with `host not found in upstream "backend"`.
- **`start_period: 30s`.** Spring Boot plus the JDBC pool takes several seconds to start. Failures during the start period don't count against `retries`.
- **Readiness vs liveness.** `/actuator/health/readiness` says "send me traffic", which is what `depends_on` wants. `server.shutdown=graceful` in `application.properties` lets in-flight requests finish on SIGTERM.
- **The missing-password error.** Without `.env`, `docker compose config` fails with: `required variable DB_PASSWORD is missing a value: set DB_PASSWORD in .env`.

### Extra credit

- Move `DB_PASSWORD` to a Compose secret. Spring can read it with `spring.config.import=configtree:/run/secrets/`.
- Replace `eclipse-temurin:21-jre` with a `jlink`-built custom runtime and compare image sizes. What does that do to your bash healthcheck?
- Build both images for `linux/amd64` and `linux/arm64` with `docker buildx bake`.
