# syntax=docker/dockerfile:1.9

# --- Builder stage ---------------------------------------------------------
FROM node:24-alpine AS builder

# better-sqlite3 needs a native build toolchain.
RUN apk add --no-cache build-base python3

# Skip husky hook installation inside Docker (no .git, not needed).
ENV HUSKY=0

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
# --ignore-scripts prevents prune from re-running `prepare` (which invokes
# husky, now missing because it's a dev dep).
RUN pnpm prune --prod --ignore-scripts

# --- Production stage ------------------------------------------------------
FROM node:24-alpine AS production

# Build-time arg populated by CI from the commit SHA; surfaced at runtime
# so the /health endpoint can report which version is running.
ARG VERSION=dev
ENV HOMEBOT_VERSION=$VERSION

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
