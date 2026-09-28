# 13. "password authentication failed" after rotating the DB password (Hard)

## Situation

Security asked the team to rotate the Postgres password (ticket SEC-412). An engineer generated a new one with `openssl rand -base64 12`, put it in `.env`, and ran:

```bash
docker compose up -d
```

`db` reports **healthy**, but every API request fails with a 500. The first log line makes no sense:

```
WARN[0000] The "Lq" variable is not set. Defaulting to a blank string.
psycopg.OperationalError: [Errno -8] Servname not supported for ai_socktype
```

A teammate "fixes" that error by URL-encoding the password by hand. After that, the error becomes:

```
FATAL:  password authentication failed for user "app"
```

Running `docker compose exec db printenv POSTGRES_PASSWORD` shows the new password, so "Postgres clearly has it".

```
# .env
POSTGRES_PASSWORD=Xk9$Lq/7mZ+2
```

```yaml
api:
  environment:
    DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
db:
  image: postgres:16
  env_file: .env
  volumes:
    - pgdata:/var/lib/postgresql/data
```

## Your task

There are **three** separate bugs stacked on top of each other. Find each one, explain it, and fix it. You must **not** lose the data in `pgdata`.

## Hint

- Run `docker compose config` and compare the password it prints with the one in `.env`.
- Where does libpq expect the `@` in `scheme://user:pass@host:port/db`, and what does it do when it sees a `/` first?
- When does the official `postgres` image actually *read* `POSTGRES_PASSWORD`? What does `pg_isready` check?

---

## Solution

### Bug 1: Compose interpolates `$` in `.env`

Unquoted and double-quoted values in `.env` go through variable interpolation. `$Lq` is read as a variable named `Lq`, which isn't set, so it becomes an empty string. The password Compose actually uses is `Xk9/7mZ+2`, which is not what the engineer saved in the password manager.

Fix: single-quote the value (literal), or escape with `$$`:

```
POSTGRES_PASSWORD='Xk9$Lq/7mZ+2'
```

`docker compose config` now shows `Xk9$$Lq/7mZ+2`. That is Compose's escaped form of a literal `$`.

### Bug 2: the password breaks the connection URL

Base64 passwords contain `/` and `+`. libpq scans `app:Xk9/7mZ+2@db...` for `@` or `/` and hits the `/` first. It concludes there are no credentials, so it reads `app` as the host and `Xk9` as the **port**. `getaddrinfo()` rejects `Xk9` as a service name: `Servname not supported for ai_socktype`.

Fix: don't put secrets in URLs. libpq reads standard `PG*` environment variables, so pass them separately and connect with an empty conninfo:

```yaml
api:
  environment:
    PGHOST: db
    PGUSER: ${POSTGRES_USER}
    PGPASSWORD: ${POSTGRES_PASSWORD}
    PGDATABASE: ${POSTGRES_DB}
```

```python
with psycopg.connect("") as conn:   # libpq picks up PG* vars
```

If a URL is unavoidable, encode the password with `urllib.parse.quote(pw, safe="")`. Don't encode it by hand in `.env`.

### Bug 3: `POSTGRES_PASSWORD` is only used on first init

The image's entrypoint runs `initdb` and sets the password **only when the data directory is empty**. `pgdata` already exists, so the role still has the *old* password. `printenv` shows what the container was given, not what's stored in `pg_authid`.

`pg_isready` only checks that the server accepts connections. It never authenticates, so `db` is "healthy" the whole time.

Fix without losing data: change the role's password inside the database. The official image trusts local socket connections, so no password is needed:

```bash
docker compose exec db psql -U app -d app
app=# \password app          -- prompts, no shell quoting issues with $
```

Then restart the API. (`docker compose down -v` also "works", but it **deletes the database**.)

### Verify

```bash
docker compose config | grep -E 'PGPASSWORD|POSTGRES_PASSWORD'   # both Xk9$$Lq/7mZ+2
docker compose up -d --build --wait
curl localhost:8000/health                                        # {"db":"ok"}
```

### Rotation runbook (what the team should do next time)

1. Generate the password and store it quoted or as a Compose **secret** (`POSTGRES_PASSWORD_FILE=/run/secrets/db_password`). A file avoids interpolation entirely.
2. `ALTER ROLE app PASSWORD ...` in the running database.
3. Update the secret and restart only the clients.
4. Optionally, make the healthcheck authenticate: `psql -h 127.0.0.1 -U app -d app -c 'select 1'` with `PGPASSWORD` set, so a wrong password shows up as "unhealthy" instead of a 500.
