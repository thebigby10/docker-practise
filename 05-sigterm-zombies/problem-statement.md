# 5. `docker stop` always takes 10 seconds and loses jobs (Medium-Hard)

## Situation

Every `docker compose down` hangs for exactly 10 seconds per worker container. In-flight queue jobs are lost on each deploy. `docker top` also shows a growing number of `<defunct>` processes in a long-running container.

```dockerfile
CMD npm run start:worker
```

## Your task

Explain why the signal is being ignored. Make the worker finish its current job and exit cleanly on SIGTERM, and get rid of the zombie processes.

## Hint

Find out what PID 1 is inside the container. Then compare shell form and exec form, and look at `init: true` and `stop_grace_period`.

---

## Solution

### Why the signal is ignored

`CMD npm run start:worker` uses the **shell form**. Docker wraps it as `/bin/sh -c "npm run start:worker"`. So:

- **PID 1 is `/bin/sh`**, not your Node process. `docker stop` sends SIGTERM to PID 1 (the shell). `sh` does not forward signals to its children, so Node never sees SIGTERM. After `stop_grace_period` (default 10 s) Docker sends SIGKILL. That is the exact 10-second hang and the lost in-flight jobs.
- **Zombies.** The shell (or npm) is a poor init: it does not reap orphaned child processes, so terminated children stay as `<defunct>` entries. A real init process is needed.

### Fix 1: use exec form so the app is PID 1

```dockerfile
CMD ["node", "worker.js"]
```

Now SIGTERM reaches Node directly. But the app must still handle it.

### Fix 2: handle SIGTERM and finish the current job

```js
const queue = require("./queue");

let shuttingDown = false;

async function handleJob(job) {
  // ...process the job
}

async function run() {
  while (!shuttingDown) {
    const job = await queue.get(); // long-poll / blocking get
    if (!job) continue;
    await handleJob(job);
  }
}

process.on("SIGTERM", () => {
  console.log("SIGTERM received: finishing current job, then exiting");
  shuttingDown = true;
});

process.on("SIGINT", () => {
  shuttingDown = true;
});

run().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
```

The loop checks `shuttingDown` *between* jobs, so the current job always completes. If `queue.get()` blocks for a long time, give it a timeout so shutdown is bounded:

```js
const job = await queue.get({ timeoutMs: 1000 });
```

### Fix 3: reap zombies with `init: true`

Compose has a built-in tiny init (tini). Set it so PID 1 forwards signals and reaps children:

```yaml
services:
  worker:
    build: .
    init: true
    stop_grace_period: 30s
```

Alternatively use `tini` explicitly:

```dockerfile
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "worker.js"]
```

### Fix 4: give shutdown enough time

`stop_grace_period` must exceed the longest expected job. Default is 10 s; set it to your p99 job duration (e.g. `30s`). Docker sends SIGKILL after this, so make it generous but bounded.

### Final Compose service

```yaml
services:
  worker:
    build: .
    init: true
    stop_grace_period: 30s
    environment:
      NODE_ENV: production
```

### Verify

```bash
docker compose up -d
docker compose exec worker ps -o pid,ppid,stat,cmd   # node is PID 1 (or tini is)
# start a job, then:
time docker compose stop worker    # should return in < grace period, not 10s flat
docker compose logs worker | grep "finishing current job"
docker compose exec worker ps -o stat | grep Z   # no zombies
```

### Notes

- `npm` as PID 1 is also bad: `npm run` spawns a child and can swallow signals. Even the exec form of `npm run ...` is avoidable — run `node` directly.
- If the app uses a library that registers its own SIGTERM handler, make sure it does not call `process.exit()` before the in-flight job finishes.
- For long jobs, consider a heartbeat/visibility timeout in the queue so a killed worker's job is redelivered rather than lost.