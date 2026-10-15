# Reomi

Anki reimagined — graph learning, garden gamification, grounded AI chat, and notebook-style source study.

Reomi is a Bun-workspace monorepo with an Elysia/Better Auth/Drizzle API and a Next.js 16/React 19 frontend. The current toolchain baseline is Bun 1.4.2, TypeScript 7.0.2, Node 26 Current for the standalone web image, and PostgreSQL 18 with pgvector 0.8.2.

The September 2026 dependency refresh uses Elysia 1.4.30, Next.js 16.3.5, React 19.3.0, and OpenSpec 1.13.1. Better Auth stays on `~1.6.33`: [1.7 requires an account-identity migration](https://github.com/better-auth/better-auth/releases/tag/v1.7.0), so a routine install must not cross that boundary. Mermaid stays on `^11.17.2`: [12 changes diagram defaults and requires Safari 17.4+](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.0.0). Both upgrades need a separate compatibility review.

## Layout

```text
apps/web           # Next.js App Router, client-first UI, port 3001
apps/api           # Elysia HTTP server on Bun, port 3000
packages/db        # Drizzle schema, client, seed, and versioned migrations
packages/auth      # Better Auth configuration shared by API and web
packages/shared    # Pure TypeScript types and FSRS helpers
docker-compose.yml # Local PostgreSQL 18 + pgvector 0.8.2
```

## Requirements

- Bun 1.4.2 (the version pinned by `packageManager`, CI, and Docker)
- Node 26 when running Node-based tooling outside Bun/Docker (`.node-version`)
- Docker with Compose v2
- A root `.env`, initially copied from `.env.example`

AI, email, web-search, and external object-storage credentials are optional. Without AI keys, the indexing/chat surfaces degrade gracefully and the rest of the application remains available.

## First-time setup

```bash
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d postgres
bun run db:migrate:apply
```

The local Compose stack initializes both `neuronexus` and `neuronexus_test`. To add demo/reference data, run `bun run db:seed`.

## Development

```bash
bun run dev           # web :3001 + API :3000
bun run dev:web       # Next.js only
bun run dev:api       # Elysia only, with reload
```

Open `http://localhost:3001`; a fresh database redirects to `/auth/sign-up`. Swagger UI is available at `http://localhost:3000/docs`.

Next uses local URL fallbacks when `apps/web/.env.local` is absent. If browser-facing values need to come from the root environment during local development, symlink `apps/web/.env.local` to `../../.env` instead of maintaining a second env file.

## Verification

```bash
bun run typecheck     # every workspace
bun run test          # full unit + API integration suite; prepares test DB first
bun run build         # API bundle + Next.js production build
bun audit             # dependency vulnerability audit
```

There is currently no separate linter. Pull requests require typecheck, the full test suite, and clean production builds.

## Database commands

```bash
bun run db:push                # destructive schema sync for disposable dev data
bun run db:push:test           # same against TEST_DATABASE_URL
bun run db:generate            # generate the next versioned SQL migration
bun run db:migrate:apply       # apply the committed migration chain
bun run db:migrate:apply:test  # apply it against the test database
bun run db:seed                # seed local demo/reference data
bun run db:studio              # open Drizzle Studio
```

Production-bound schema changes use `db:generate`, reviewed/committed SQL, and `db:migrate:apply`. Use `db:push --force` only when the target data is disposable and the change needs no ordered backfill.

## Containers

- `apps/api/Dockerfile` builds and runs on `oven/bun:1.4.2-alpine` and applies pending migrations before API startup.
- `apps/web/Dockerfile` builds with Bun 1.4.2 and runs the Next standalone output on Node 26 Alpine.
- Both Compose files use `pgvector/pgvector:0.8.2-pg18`. PostgreSQL 18 volumes mount at `/var/lib/postgresql`; upgrading from an older major requires `pg_upgrade` or a fresh disposable volume.

Production logging, readiness, request-correlation, and shutdown operations are documented in [`docs/observability.md`](docs/observability.md).

See `.env.example` for configuration and `CLAUDE.md` / `AGENTS.md` for the detailed architecture and repository-working contract.
