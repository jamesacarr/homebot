# syntax=docker/dockerfile:1.9

# --- Builder stage ---------------------------------------------------------
FROM node:24-alpine AS builder

# better-sqlite3 needs a native build toolchain.
RUN apk add --no-cache build-base python3

# Enable corepack so pnpm matches what's declared in package.json (if pinned).
RUN corepack enable

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Build.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# Strip devDependencies from node_modules for the runtime stage.
RUN pnpm prune --prod

# --- Production stage ------------------------------------------------------
FROM node:24-alpine AS production

# curl: used by the compose-level healthcheck.
RUN apk add --no-cache curl \
 && addgroup -S homebot \
 && adduser -S homebot -G homebot \
 && mkdir -p /data \
 && chown homebot:homebot /data

WORKDIR /app

COPY --from=builder --chown=homebot:homebot /app/node_modules ./node_modules
COPY --from=builder --chown=homebot:homebot /app/dist ./dist
COPY --from=builder --chown=homebot:homebot /app/package.json ./package.json

USER homebot

ENV NODE_ENV=production
ENV DB_PATH=/data/homebot.db

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "dist/index.js"]
