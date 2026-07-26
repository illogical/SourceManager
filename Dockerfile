FROM oven/bun:1-debian AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY frontend ./frontend
COPY src ./src
COPY tsconfig.json ./
RUN bun run frontend:build

FROM oven/bun:1-debian AS runtime

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git net-tools nodejs npm procps \
    && npm install --global pnpm yarn \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build --chown=bun:bun /app/package.json /app/bun.lock ./
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/frontend/dist ./frontend/dist
COPY --chown=bun:bun data/projects.example.json ./data/projects.example.json

USER bun

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl --fail --silent "http://localhost:${SOURCEMANAGER_PORT}/health" > /dev/null || exit 1

CMD ["bun", "run", "start"]
