# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# A throwaway secret just for the build step; the real one is supplied at runtime.
RUN APP_SECRET=build-only-secret-build-only-secret-123 DISABLE_JOBS=1 npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 \
    DATA_DIR=/data MIGRATIONS_DIR=/app/drizzle
RUN groupadd -r hearth && useradd -r -g hearth -d /app hearth && mkdir -p /data && chown hearth:hearth /data
COPY --from=build --chown=hearth:hearth /app/.next/standalone ./
COPY --from=build --chown=hearth:hearth /app/.next/static ./.next/static
COPY --from=build --chown=hearth:hearth /app/public ./public
COPY --from=build --chown=hearth:hearth /app/drizzle ./drizzle
COPY --from=build --chown=hearth:hearth /app/scripts/restore.mjs ./scripts/restore.mjs
USER hearth
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
