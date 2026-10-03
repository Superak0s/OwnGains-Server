# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm prune --prod

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:24-alpine AS production

LABEL org.opencontainers.image.title="OwnGains Server" \
      org.opencontainers.image.description="Optional backend for the OwnGains fitness app: accounts, workout sync, and real-time social features (friends, joint workouts, live spectating). REST + WebSocket API on MySQL/MariaDB." \
      org.opencontainers.image.source="https://github.com/Superak0s/OwnGains-Server" \
      org.opencontainers.image.licenses="MIT"

# mysql-client and age back `owngains backup` (dump, restore, encryption).
RUN apk add --no-cache tini mysql-client age

WORKDIR /app

COPY package.json LICENSE THIRD_PARTY_NOTICES ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN printf '#!/bin/sh\nexec node /app/dist/owngains.js "$@"\n' > /usr/local/bin/owngains && chmod +x /usr/local/bin/owngains
# /app stays root-owned: the server never writes to its own code or
# node_modules (photos live in MySQL), so a compromised process running as
# appuser has no business being able to rewrite them.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
# Mount a volume here, or backups vanish with the container.
RUN mkdir -m 700 /backups && chown appuser:appgroup /backups
ENV BACKUP_DIR=/backups
USER appuser

EXPOSE 5000
ENV NODE_ENV=production
# bcrypt, sharp, gzip and fs all share libuv's threadpool (default 4).
ENV UV_THREADPOOL_SIZE=8
# start-period: first boot provisions the whole schema (CREATE DATABASE, ~30
# CREATE TABLE, migrations), during which the container would flap unhealthy.
# The port comes from the container's env, so a PORT override doesn't turn the
# container permanently unhealthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 5000) + '/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--env-file-if-exists=.env", "dist/server.js"]