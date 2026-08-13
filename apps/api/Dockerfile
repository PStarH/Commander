# syntax=docker/dockerfile:1
# =============================================================================
# Commander — API Service Dockerfile
# Self-contained multi-stage build for apps/api and its workspace dependencies.
#
# Build context MUST be the monorepo root so that pnpm-workspace.yaml and the
# workspace packages are reachable.
#
# Build:   docker build -f apps/api/Dockerfile -t commander-api .
# Run:     docker run -p 4000:4000 --env-file .env commander-api
# =============================================================================

# ---- Stage 1: Base ----
# SECURITY: pin to a specific patch version to avoid unexpected upstream updates.
# For maximum supply-chain assurance, replace with an image digest
# (FROM node:22.x.x-alpine@sha256:<digest>).
FROM node:22.14.0-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# ---- Stage 2: Dependencies ----
# Install build tools for native modules (better-sqlite3, optional isolated-vm).
FROM base AS deps
RUN apk add --no-cache python3 make g++

# Copy workspace manifests. Only the packages in the dependency closure are
# needed at runtime, but pnpm needs every workspace package.json present to
# resolve workspace links during install.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/kernel/package.json ./packages/kernel/package.json
COPY packages/effect-broker/package.json ./packages/effect-broker/package.json
COPY apps/api/package.json ./apps/api/package.json

# Install only the workspace packages required by the API service and their
# transitive dependencies. The root devDependencies (typescript, tsx, etc.)
# are installed because they are required to build.
RUN pnpm install --frozen-lockfile \
    --filter @commander/contracts \
    --filter @commander/plugin-sdk \
    --filter @commander/core \
    --filter @commander/kernel \
    --filter @commander/effect-broker \
    --filter @commander/api

# ---- Stage 3: Build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/plugin-sdk/node_modules ./packages/plugin-sdk/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/kernel/node_modules ./packages/kernel/node_modules
COPY --from=deps /app/packages/effect-broker/node_modules ./packages/effect-broker/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules

COPY tsconfig.base.json ./
COPY tsconfig.strict.json ./
COPY scripts/fix-esm-imports.mjs ./scripts/fix-esm-imports.mjs
COPY packages/contracts ./packages/contracts
COPY packages/plugin-sdk ./packages/plugin-sdk
COPY packages/core ./packages/core
COPY packages/kernel ./packages/kernel
COPY packages/effect-broker ./packages/effect-broker
COPY apps/api ./apps/api

# Build workspace packages in dependency order. Core is type-checked first
# because API path-maps to core's compiled declarations. After each tsc emit,
# fix-esm-imports adds the `.js` extensions that Node.js ESM requires.
RUN cd packages/contracts && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd packages/plugin-sdk && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd packages/core && pnpm exec tsc --noEmit && pnpm exec tsc -p tsconfig.json && test -f dist/index.d.ts && node ../../scripts/fix-esm-imports.mjs dist
RUN cd packages/effect-broker && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd packages/kernel && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd apps/api && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist

# ---- Stage 4: Production ----
FROM base AS production

# SECURITY: run as non-root. tini provides proper signal handling.
RUN apk add --no-cache tini=0.19.0-r3 \
    && addgroup -g 1001 commander \
    && adduser -u 1001 -G commander -s /bin/sh -D commander \
    && mkdir -p /app/.commander_state \
               /app/.commander_traces \
               /app/.commander_memory \
               /app/.commander_results \
    && chown -R commander:commander /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/plugin-sdk/node_modules ./packages/plugin-sdk/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/kernel/node_modules ./packages/kernel/node_modules
COPY --from=deps /app/packages/effect-broker/node_modules ./packages/effect-broker/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules

COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/contracts/schemas ./packages/contracts/schemas
COPY --from=build /app/packages/contracts/fixtures ./packages/contracts/fixtures
COPY --from=build /app/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/kernel/dist ./packages/kernel/dist
COPY --from=build /app/packages/effect-broker/dist ./packages/effect-broker/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist

COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/kernel/package.json ./packages/kernel/package.json
COPY packages/effect-broker/package.json ./packages/effect-broker/package.json
COPY apps/api/package.json ./apps/api/package.json

RUN chown -R commander:commander /app

EXPOSE 4000

ENV NODE_ENV=production
ENV PORT=4000

USER commander

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
