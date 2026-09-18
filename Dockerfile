# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S aster && adduser -S aster -G aster
COPY --from=build --chown=aster:aster /app/.next/standalone ./
COPY --from=build --chown=aster:aster /app/.next/static ./.next/static
COPY --from=build --chown=aster:aster /app/public ./public
# SQL migrations are applied automatically on boot.
COPY --from=build --chown=aster:aster /app/drizzle ./drizzle
USER aster
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
