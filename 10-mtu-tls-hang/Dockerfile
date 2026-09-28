FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY . .
CMD ["sh", "-c", "curl -sSI https://registry.npmjs.org/ | head -1"]