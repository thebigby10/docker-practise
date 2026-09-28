# 12. Spring Boot image: "no main manifest attribute" in CI, old code on laptops (Hard)

## Situation

A Spring Boot 3 service (Java 21, Maven) is containerised with a multi-stage build. Company policy forbids `spring-boot-starter-parent`, so the `pom.xml` imports `spring-boot-dependencies` as a BOM instead.

Three complaints arrive the same week:

1. **CI** (fresh checkout): the image builds, but the container exits immediately:
   ```
   $ docker run --rm demo
   no main manifest attribute, in app.jar
   ```
2. **A developer's laptop:** the image builds *and starts*, but `GET /hello` (added last sprint) returns 404. It's as if the code is weeks old. The developer ran `mvn package` locally a while ago, when the version was `1.9.0-SNAPSHOT`. It is now `1.10.0-SNAPSHOT`.
3. **Everyone:** changing one line of Java re-downloads half of Maven Central. Builds take 4+ minutes.

```dockerfile
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY . .
RUN mvn -q package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/target/*.jar app.jar
ENTRYPOINT ["java", "-jar", "app.jar"]
```

## Your task

Find the root cause of each complaint and fix all three. The fixed image must:

- run on a clean checkout **and** on a dirty laptop
- rebuild in seconds after a source-only change
- run as a non-root user

## Hint

- Unzip the jar and read `META-INF/MANIFEST.MF`. What does `spring-boot-starter-parent` configure for `spring-boot-maven-plugin` that a plain BOM import doesn't?
- `ls target/` on the laptop, then sort the jar names the way a glob does.
- What does `COPY . .` do to the layer cache every time any file changes?

---

## Solution

### Bug 1: the jar was never repackaged

`spring-boot-starter-parent` binds the `repackage` goal of `spring-boot-maven-plugin` in its `<pluginManagement>`. With a BOM import you get dependency versions, **not plugin configuration**. Declaring the plugin without an execution does nothing. The result is the plain `maven-jar-plugin` jar: your classes only, no `Main-Class`, no dependencies.

```bash
unzip -p app.jar META-INF/MANIFEST.MF   # no Main-Class / Start-Class
```

Fix: bind the goal explicitly and give the jar a stable name:

```xml
<build>
  <finalName>app</finalName>
  <plugins>
    <plugin>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-maven-plugin</artifactId>
      <version>${spring-boot.version}</version>
      <executions>
        <execution>
          <goals>
            <goal>repackage</goal>
          </goals>
        </execution>
      </executions>
    </plugin>
  </plugins>
</build>
```

### Bug 2: host `target/` leaks into the build and the glob picks the wrong jar

There is no `.dockerignore`, so `COPY . .` sends the laptop's `target/demo-1.9.0-SNAPSHOT.jar` into the build stage. `mvn package` then adds `demo-1.10.0-SNAPSHOT.jar` next to it. `COPY target/*.jar app.jar` matches **both**. Current BuildKit copies them one after the other onto the same file, so the last one wins. Globs sort lexically, and `1.9.0` sorts after `1.10.0`, so **the stale jar ships silently**.

Older builders failed loudly instead: `When using COPY with more than one source file, the destination must be a directory and end with a /`. The silent version is worse.

Fix: add a `.dockerignore`, and copy the exact file name (`<finalName>app</finalName>`) instead of a glob:

```
target/
.git
.idea
*.iml
```

### Bug 3: dependency download is never cached

`COPY . .` puts every source file into the layer before `mvn` runs, so any edit invalidates the step that downloads dependencies. Copy `pom.xml` first, resolve dependencies, then copy `src`. Also add a BuildKit cache mount so `~/.m2` persists across builds, including when `pom.xml` changes:

```dockerfile
# syntax=docker/dockerfile:1
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -B -q dependency:go-offline
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -B -q package -DskipTests

FROM eclipse-temurin:21-jre
RUN useradd --uid 10001 --no-create-home app
WORKDIR /app
COPY --from=build /src/target/app.jar app.jar
USER 10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
```

`dependency:go-offline` doesn't resolve every plugin that `package` needs. The cache mount covers the rest.

### Verify

```bash
mkdir -p target && echo STALE > target/demo-1.9.0-SNAPSHOT.jar   # simulate the dirty laptop
docker build -t demo .
docker run --rm -p 8080:8080 demo
curl localhost:8080/hello                                        # hello from demo
echo '// touch' >> src/main/java/com/example/demo/DemoApplication.java
time docker build -t demo .                                      # seconds, no downloads
```

### Extra credit

- Split the fat jar into layers (`java -Djarmode=tools -jar app.jar extract --layers --launcher`) so a code change pushes a ~10 KB layer instead of a ~20 MB one.
- Add `-XX:MaxRAMPercentage=75` via `JAVA_TOOL_OPTIONS` (see problem 7).
- Write a one-line CI check that fails the build if `unzip -p app.jar META-INF/MANIFEST.MF` has no `Start-Class`.
