# syntax=docker/dockerfile:1
# =============================================================================
# Commander — Operations Service Dockerfile
# Self-contained multi-stage build for packages/operations and its workspace
# dependencies.
#
# Build context MUST be the monorepo root so that pnpm-workspace.yaml and the
# workspace packages are reachable.
#
# This image supports two execution modes:
#   1. timer  -> node packages/operations/dist/timerWakeupWorkerMain.js
#   2. outbox -> node packages/operations/dist/outboxPublisherMain.js
#
# Mode selection:
#   * Build-time (default): use the OPERATIONS_MODE build argument. The chosen
#     mode is baked into the image ENTRYPOINT.
#     Examples:
#       docker build -f packages/operations/Dockerfile -t commander-operations --build-arg OPERATIONS_MODE=timer .
#       docker build -f packages/operations/Dockerfile -t commander-operations --build-arg OPERATIONS_MODE=outbox .
#   * Runtime override: pass a custom entrypoint to docker run, ignoring the
#     baked-in default.
#     Examples:
#       docker run --entrypoint 'node' commander-operations packages/operations/dist/timerWakeupWorkerMain.js
#       docker run --entrypoint 'node' commander-operations packages/operations/dist/outboxPublisherMain.js
#   * Compose override: set the service `entrypoint` or `command` field.
#     Examples:
#       entrypoint: ["node", "packages/operations/dist/timerWakeupWorkerMain.js"]
#       entrypoint: ["node", "packages/operations/dist/outboxPublisherMain.js"]
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
COPY packages/kernel/package.json ./packages/kernel/package.json
COPY packages/operations/package.json ./packages/operations/package.json

# Install only the workspace packages required by the operations service and
# their transitive dependencies.
RUN pnpm install --frozen-lockfile \
    --filter @commander/contracts \
    --filter @commander/kernel \
    --filter @commander/operations

# ---- Stage 3: Build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/kernel/node_modules ./packages/kernel/node_modules
COPY --from=deps /app/packages/operations/node_modules ./packages/operations/node_modules

COPY tsconfig.base.json ./
COPY scripts/fix-esm-imports.mjs ./scripts/fix-esm-imports.mjs
COPY packages/contracts ./packages/contracts
COPY packages/kernel ./packages/kernel
COPY packages/operations ./packages/operations

# Build workspace packages in dependency order. After each tsc emit,
# fix-esm-imports adds the `.js` extensions that Node.js ESM requires.
RUN cd packages/contracts && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd packages/kernel && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd packages/operations && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist

# ---- Stage 4: Production ----
FROM base AS production

# OPERATIONS_MODE selects the default entrypoint at build time.
# Valid values: timer (default) | outbox
ARG OPERATIONS_MODE=timer
ENV OPERATIONS_MODE=${OPERATIONS_MODE}

# SECURITY: run as non-root.
RUN addgroup -g 1001 commander \
    && adduser -u 1001 -G commander -s /bin/sh -D commander \
    && mkdir -p /app/.commander_state \
    && chown -R commander:commander /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/kernel/node_modules ./packages/kernel/node_modules
COPY --from=deps /app/packages/operations/node_modules ./packages/operations/node_modules

COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/kernel/dist ./packages/kernel/dist
COPY --from=build /app/packages/operations/dist ./packages/operations/dist

COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/kernel/package.json ./packages/kernel/package.json
COPY packages/operations/package.json ./packages/operations/package.json

# Install a tiny entrypoint script that resolves OPERATIONS_MODE to the correct
# main file. This keeps the default behavior configurable while still allowing
# the entrypoint to be overridden at runtime.
RUN cat <<'EOF' > /app/entrypoint.sh
#!/bin/sh
set -e
case "${OPERATIONS_MODE}" in
  timer)
    exec node packages/operations/dist/timerWakeupWorkerMain.js
    ;;
  outbox)
    exec node packages/operations/dist/outboxPublisherMain.js
    ;;
  *)
    echo "Unknown OPERATIONS_MODE: ${OPERATIONS_MODE}. Use 'timer' or 'outbox'." >&2
    exit 1
    ;;
esac
EOF
RUN chmod +x /app/entrypoint.sh && chown commander:commander /app/entrypoint.sh

RUN chown -R commander:commander /app

ENV NODE_ENV=production

USER commander

ENTRYPOINT ["/app/entrypoint.sh"]
