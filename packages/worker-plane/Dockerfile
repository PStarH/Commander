# syntax=docker/dockerfile:1
# =============================================================================
# Commander — Worker Plane Service Dockerfile
# Self-contained multi-stage build for packages/worker-plane and its workspace
# dependencies.
#
# Build context MUST be the monorepo root so that pnpm-workspace.yaml and the
# workspace packages are reachable.
#
# Build:   docker build -f packages/worker-plane/Dockerfile -t commander-worker .
# Run:     docker run --env-file .env commander-worker
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
COPY packages/action-adapters/package.json ./packages/action-adapters/package.json
COPY packages/worker-plane/package.json ./packages/worker-plane/package.json

# Install only the workspace packages required by the worker service and their
# transitive dependencies.
RUN pnpm install --frozen-lockfile \
    --filter @commander/contracts \
    --filter @commander/plugin-sdk \
    --filter @commander/core \
    --filter @commander/kernel \
    --filter @commander/effect-broker \
    --filter @commander/action-adapters \
    --filter @commander/worker-plane

# ---- Stage 3: Build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/plugin-sdk/node_modules ./packages/plugin-sdk/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/kernel/node_modules ./packages/kernel/node_modules
COPY --from=deps /app/packages/effect-broker/node_modules ./packages/effect-broker/node_modules
COPY --from=deps /app/packages/action-adapters/node_modules ./packages/action-adapters/node_modules
COPY --from=deps /app/packages/worker-plane/node_modules ./packages/worker-plane/node_modules

COPY tsconfig.base.json ./
COPY tsconfig.strict.json ./
COPY scripts/fix-esm-imports.mjs ./scripts/fix-esm-imports.mjs
COPY packages/contracts ./packages/contracts
COPY packages/plugin-sdk ./packages/plugin-sdk
COPY packages/core ./packages/core
COPY packages/kernel ./packages/kernel
COPY packages/effect-broker ./packages/effect-broker
COPY packages/action-adapters ./packages/action-adapters
COPY packages/worker-plane ./packages/worker-plane

# Build workspace packages in dependency order. After each tsc emit,
# fix-esm-imports adds the `.js` extensions that Node.js ESM requires.
RUN cd packages/contracts && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd packages/plugin-sdk && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd packages/core && pnpm exec tsc --noEmit && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd packages/effect-broker && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd packages/kernel && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd packages/action-adapters && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd packages/worker-plane && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist

# ---- Stage 4: Production ----
FROM base AS production

# docker-cli enables production SandboxManager DockerSB when the host/cell
# mounts /var/run/docker.sock (see docker-compose.cell.yml). No silent
# ALLOW_NO_SANDBOX bypass — discovery still requires a live docker daemon.
# su-exec: entrypoint drops root after aligning sock GID (cell DOCKER_GID).
RUN apk add --no-cache docker-cli su-exec

# SECURITY: run as non-root (entrypoint starts as root then su-exec).
RUN addgroup -g 1001 commander \
    && adduser -u 1001 -G commander -s /bin/sh -D commander \
    && mkdir -p /app/.commander_state \
    && chown -R commander:commander /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/plugin-sdk/node_modules ./packages/plugin-sdk/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/kernel/node_modules ./packages/kernel/node_modules
COPY --from=deps /app/packages/effect-broker/node_modules ./packages/effect-broker/node_modules
COPY --from=deps /app/packages/action-adapters/node_modules ./packages/action-adapters/node_modules
COPY --from=deps /app/packages/worker-plane/node_modules ./packages/worker-plane/node_modules

COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/contracts/schemas ./packages/contracts/schemas
COPY --from=build /app/packages/contracts/fixtures ./packages/contracts/fixtures
COPY --from=build /app/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/kernel/dist ./packages/kernel/dist
COPY --from=build /app/packages/effect-broker/dist ./packages/effect-broker/dist
COPY --from=build /app/packages/action-adapters/dist ./packages/action-adapters/dist
COPY --from=build /app/packages/worker-plane/dist ./packages/worker-plane/dist

COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/kernel/package.json ./packages/kernel/package.json
COPY packages/effect-broker/package.json ./packages/effect-broker/package.json
COPY packages/action-adapters/package.json ./packages/action-adapters/package.json
COPY packages/worker-plane/package.json ./packages/worker-plane/package.json
COPY packages/worker-plane/docker-entrypoint.sh /usr/local/bin/commander-worker-entrypoint.sh

RUN chmod +x /usr/local/bin/commander-worker-entrypoint.sh \
    && chown -R commander:commander /app

ENV NODE_ENV=production

# Root only long enough for docker.sock GID alignment; process runs as commander.
USER root

ENTRYPOINT ["/usr/local/bin/commander-worker-entrypoint.sh"]
