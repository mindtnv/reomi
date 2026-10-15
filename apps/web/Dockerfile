# syntax=docker/dockerfile:1.24.0
# ── Web Dockerfile (Next.js 16 standalone) ────────────────────────────────
# Build from the repo root so bun workspaces resolve `@reomi/*`.
#
#   docker build -f apps/web/Dockerfile -t neuronexus-web:latest .

FROM oven/bun:1.4.2-alpine AS deps
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
COPY apps/api/ apps/api/
# NEXT_PUBLIC_* are BAKED at build time (webpack DefinePlugin + the resolved
# rewrites/headers in routes-manifest). Pass them as --build-arg; the defaults
# keep plain local `docker build` behavior identical to dev.
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ARG NEXT_PUBLIC_MEDIA_BASE_URL=http://localhost:9000/neuronexus-media
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_MEDIA_BASE_URL=$NEXT_PUBLIC_MEDIA_BASE_URL
# Next.js ships a tiny runtime if we configure `output: 'standalone'` in
# next.config.ts — see next.config.ts. This makes the final image ~120 MB
# instead of ~800 MB.
WORKDIR /repo/apps/web
RUN bun run build

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
EXPOSE 3001
USER node
CMD ["node", "apps/web/server.js"]
