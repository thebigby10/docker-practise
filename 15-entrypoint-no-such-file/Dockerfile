FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY App.java .
RUN javac App.java && jar --create --file app.jar --main-class App *.class

# Slim runtime: plain Alpine + distro JRE (~60 MB smaller than the temurin image)
FROM alpine:3.20
RUN apk add --no-cache openjdk21-jre-headless
WORKDIR /app
COPY --from=build /src/app.jar .
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
