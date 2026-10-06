# ─── Build stage ─────────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build
RUN bun install --frozen-lockfile --production

# ─── Production stage ────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS production

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

RUN printf '#!/bin/sh\nexec bun /app/dist/owngains.js "$@"\n' > /usr/local/bin/owngains && chmod +x /usr/local/bin/owngains
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
# start-period: first boot provisions the whole schema (CREATE DATABASE, ~30
# CREATE TABLE, migrations), during which the container would flap unhealthy.
# The port comes from the container's env, so a PORT override doesn't turn the
# container permanently unhealthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s CMD bun -e "fetch('http://localhost:' + (process.env.PORT || 5000) + '/healthz').then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "dist/server.js"]