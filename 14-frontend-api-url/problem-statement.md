# 14. The frontend calls `/undefined/todos` (Medium)

## Situation

A Vite single-page app (JavaScript) is built into an nginx image. A small Node API runs next to it. `compose.yaml` passes the API location to the frontend:

```yaml
web:
  build: ./frontend
  ports: ["8080:80"]
  environment:
    VITE_API_URL: http://api:3000
```

```js
const API_URL = import.meta.env.VITE_API_URL;
fetch(`${API_URL}/todos`);
```

Opening http://localhost:8080 shows an empty list. The browser's network tab shows:

```
GET http://localhost:8080/undefined/todos   404
```

A teammate moves the value into a build arg. Now the network tab shows `GET http://api:3000/todos  net::ERR_NAME_NOT_RESOLVED`, even though `docker compose exec web wget -qO- http://api:3000/todos` works fine.

The team then notices one more bug: clicking **Done** works, but refreshing the page at `/done` gives nginx's `404 Not Found`.

## Your task

Fix all three problems so that:

- the **same image** can be deployed to dev, staging, and prod without rebuilding
- the API port does not need to be published to the host
- deep links like `/done` survive a refresh
- there is no CORS configuration

## Hint

- `docker compose exec web grep -o 'const l=[^;]*' /usr/share/nginx/html/assets/*.js`. When does Vite read `import.meta.env`?
- Which machine resolves the hostname in a `fetch()` call: the container or your laptop?
- nginx's default config maps `/done` to a file on disk.

---

## Solution

### Bug 1: Vite env vars are compiled in at build time

`import.meta.env.VITE_*` is replaced with a string literal during `vite build`. The final image is static files served by nginx. Nothing reads environment variables at runtime, so the `environment:` block on `web` does nothing. The bundle literally contains `const l=void 0`. The result is `fetch("undefined/todos")`, which the browser resolves relative to the page.

### Bug 2: the browser can't resolve Compose service names

Baking it in with `ARG VITE_API_URL` gets the value into the bundle, but the JavaScript runs in the **user's browser**, not in the container. `api` only exists in Docker's embedded DNS on the Compose network. `docker compose exec web wget ...` works because that command runs *inside* the network.

Baking in `http://localhost:3000` "works" on your laptop, but it breaks every other environment. It also requires publishing the API port and adding CORS, because the page and the API are then on different origins.

### Fix for 1 and 2: same-origin reverse proxy

Have the browser call a **relative** path. nginx, which *is* on the Compose network, forwards it to the API:

```js
const API_URL = '/api';
```

`frontend/nginx.conf`:

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;

    location /api/ {
        proxy_pass http://api:3000/;   # trailing slash strips the /api prefix
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

The trailing `/` on `proxy_pass` matters. With it, `/api/todos` becomes `/todos`. Without it, the API receives `/api/todos` and returns 404.

### Bug 3: SPA deep links

nginx looks for a file called `/done` and returns 404. `try_files $uri $uri/ /index.html` serves the app shell for any unknown path, and the client-side router takes over. That's the `location /` block above.

### Final files

```dockerfile
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json .
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
```

```yaml
services:
  api:
    build: ./api          # no ports: only nginx talks to it
  web:
    build: ./frontend
    ports:
      - "8080:80"
    depends_on:
      - api
```

### Verify

```bash
docker compose up -d --build
curl localhost:8080/api/todos          # JSON from the API, through nginx
curl -o /dev/null -w '%{http_code}\n' localhost:8080/done   # 200
curl localhost:3000/todos              # connection refused: API not exposed
```

### When you really need runtime config in an SPA

If different deployments truly need different values (feature flags, a third-party API key), serve them at runtime. Generate `/config.json` (or `window.__CONFIG__` in `/env.js`) from environment variables when the container starts. The official nginx image runs `envsubst` on `/etc/nginx/templates/*.template` at startup, which covers this. Keep the value out of the JS bundle.
