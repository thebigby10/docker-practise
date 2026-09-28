FROM node:20-alpine
WORKDIR /app
ARG NPM_TOKEN
COPY package.json package-lock.json ./
RUN echo "//registry.company.com/:_authToken=${NPM_TOKEN}" > .npmrc && \
    npm ci && rm .npmrc
COPY . .
CMD ["node", "server.js"]