# syntax=docker/dockerfile:1.24.0
# ── API Dockerfile (Bun + Elysia) ──────────────────────────────────────────
# Multi-stage: install workspace deps → bundle → slim runtime image.
# Build from the repo root so bun workspaces resolve `@reomi/*` symlinks.
#
#   docker build -f apps/api/Dockerfile -t neuronexus-api:latest .
#
# Runtime env vars (no baked-in defaults — must be passed):
#   DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, WEB_ORIGIN,
#   API_PORT (default 3000), SHUTDOWN_TIMEOUT_MS (default 8000),
#   NODE_ENV=production

FROM oven/bun:1.4.2-alpine AS deps
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /repo
# bun build INLINES process.env.NODE_ENV into the bundle at build time —
# without this the dev branch of logger.ts (pino-pretty worker transport,
# unresolvable in the runtime image) gets baked in and crashes on boot.
ENV NODE_ENV=production
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
# apps/web isn't needed at runtime, but the api workspace's type-only imports
# from `@reomi/api` (eden) don't touch web — safe to skip it.
RUN cd apps/api && bun build src/index.ts --target bun --outdir ./dist --minify
# Bundle the programmatic migrator too — the runtime CMD applies committed
# migrations before starting the server (idempotent: drizzle records applied
# migrations in __drizzle_migrations).
RUN cd packages/db && bun build src/migrate.ts --target bun --outdir ./dist --minify

FROM oven/bun:1.4.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=3000
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/packages/db/dist/migrate.js ./dist/migrate.js
# migrate.js resolves `<its dir>/migrations` at runtime → bake them next to it.
COPY --from=build /repo/packages/db/src/migrations ./dist/migrations
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${API_PORT}/ready || exit 1
USER bun
# Apply pending migrations, then start. First boot runs the full chain
# (incl. 0010 `CREATE EXTENSION vector` — the DB image must ship pgvector).
CMD ["sh", "-c", "bun dist/migrate.js && exec bun dist/index.js"]
