# 7. Random exit code 137 under load (Hard)

## Situation

A Java or Node service has a 512 MB memory limit in Compose. Under load tests it dies with exit code 137 every 20–40 minutes. No application error appears in the logs. Monitoring shows the host has plenty of free RAM.

## Your task

Prove what's killing it. Then set the runtime's heap limits so the process respects the container limit and leaves headroom for non-heap memory.

## Hint

Run `docker inspect --format '{{.State.OOMKilled}}'`. Then look at `-XX:MaxRAMPercentage` or `--max-old-space-size`, and think about what else uses memory besides the heap.

---

## Solution

### What 137 means

Exit code `137` = `128 + 9` = killed by `SIGKILL`. Under a memory limit, the kernel's cgroup OOM killer sends SIGKILL. The host has free RAM because the *cgroup*, not the host, hit its limit.

### Prove it

```bash
docker inspect --format '{{.State.OOMKilled}}' <container>       # true
docker inspect --format '{{.State.ExitCode}}' <container>        # 137
docker events --filter event=oom                                # live OOM events
cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.events  # oom_kill counter
dmesg | grep -i oom | tail                                       # kernel log
docker stats --no-stream <container>                             # watch MEM LIMIT / MEM USAGE
```

`docker stats` showing `MEM USAGE` pinned at `512MiB / 512MiB` right before death confirms the cgroup limit is the trigger.

### Why the runtime exceeds the limit

A JVM or Node process uses memory beyond the heap:

- **JVM:** heap + Metaspace + thread stacks + code cache + GC structures + direct/`ByteBuffer` memory + JNI. With no container awareness the JVM sizes the default max heap from *host* RAM (25% of host), which can be far above 512 MB. Even with container awareness, a 25% default leaves too little for non-heap.
- **Node:** old space (V8 heap) + new space + external buffers + native addon memory + the runtime itself. Node's default old-space size is derived from available memory and can exceed 512 MB.

### Fix: Java

Use `-XX:MaxRAMPercentage` so the JVM reads the cgroup limit, and set it well below 100% to leave headroom:

```yaml
services:
  app:
    build: .
    mem_limit: 512m
    environment:
      JAVA_TOOL_OPTIONS: >-
        -XX:MaxRAMPercentage=60.0
        -XX:InitialRAMPercentage=40.0
        -XX:+ExitOnOutOfMemoryError
        -XX:+UseContainerSupport
    command: ["java", "-jar", "app.jar"]
```

- `UseContainerSupport` is default in JDK 10+ and makes the JVM read cgroup limits.
- `MaxRAMPercentage=60` caps heap at ~307 MB, leaving ~205 MB for Metaspace, stacks, and native memory.
- `ExitOnOutOfMemoryError` makes a heap OOM fail fast with a stack trace instead of thrashing.

### Fix: Node

```yaml
services:
  app:
    build: .
    mem_limit: 512m
    environment:
      NODE_OPTIONS: "--max-old-space-size=320"
    command: ["node", "server.js"]
```

`--max-old-space-size=320` (in MB) leaves ~190 MB for new space, external buffers, and the runtime.

### Also set the Compose limit explicitly

The `deploy.resources.limits.memory` syntax only applies in Swarm; for plain Compose use `mem_limit` (or `deploy` with `docker compose up` in recent versions). Use one consistent form:

```yaml
services:
  app:
    mem_limit: 512m
    memswap_limit: 512m   # disable swap to avoid slow death
```

### Tuning method (do not guess)

1. Load test with a generous limit and instrument RSS vs heap: `docker stats`, JVM `NativeMemoryTracking` (`-XX:NativeMemoryTracking=summary` + `jcmd VM.native_memory`), or Node `process.memoryUsage()`.
2. Set the heap cap so `peak RSS ≈ heap + steady non-heap` fits under the limit with 20–30% headroom.
3. Re-run the load test; watch `memory.events` for `oom_kill` staying at 0 and RSS peak.

### Notes

- Exit 137 can also come from `docker stop` after the grace period, or from a manual `kill -9`. Rule those out by checking `OOMKilled` and timing the death against the load test, not against a deploy.
- JVM `MaxRAMPercentage` applies to the whole cgroup; multiple containers on one host each get their own percentage of *their* limit, which is correct.
- Direct/off-heap memory (Netty, NIO) is not counted in the heap percentage; add `-XX:MaxDirectMemorySize` if you use it heavily.
- For a hard guarantee, pair the app-level limit with `mem_limit` so the two numbers cannot drift.