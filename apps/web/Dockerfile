# syntax=docker/dockerfile:1
# =============================================================================
# Commander — Web Console Dockerfile
# Self-contained multi-stage build for apps/web (Vite + React) served by nginx.
#
# Build context MUST be the monorepo root so that pnpm-workspace.yaml and the
# workspace packages are reachable.
#
# Build:   docker build -f apps/web/Dockerfile -t commander-web .
# Run:     docker run -p 3000:80 commander-web
#
# This is the tracked, canonical web image. The Compose `web` service builds
# from here — never from the repository root Dockerfile (that file is local-only
# and gitignored, so a fresh clone cannot build from it).
# =============================================================================

# ---- Stage 1: Base ----
# SECURITY: pin to a specific patch version to avoid unexpected upstream updates.
# For maximum supply-chain assurance, replace with an image digest
# (FROM node:22.x.x-alpine@sha256:<digest>).
FROM node:22.14.0-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# ---- Stage 2: Dependencies ----
FROM base AS deps
# Copy workspace manifests. apps/web only depends on @commander/contracts from
# the workspace; pnpm still needs every manifest in the closure to resolve links.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN pnpm install --frozen-lockfile \
    --filter @commander/contracts \
    --filter @commander/web

# ---- Stage 3: Build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules

COPY tsconfig.base.json ./tsconfig.base.json
COPY scripts/fix-esm-imports.mjs ./scripts/fix-esm-imports.mjs
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web

# API base URL — fixed at BUILD time, for the whole bundle.
#
# The web image is served by nginx, which proxies every API route prefix on the
# SAME origin (apps/web/nginx.conf). The bundle must therefore resolve API calls
# relatively (`/api/...`, `/projects/...`) rather than through the development
# default `http://localhost:4000`: an absolute base is cross-origin, is blocked
# by the production CSP (`connect-src 'self'`), and in a browser points at the
# end user's own machine rather than the deployment.
#
# Vite inlines process-level VITE_* variables at build time with the highest
# priority, so this is the single place the value is set for every consumer
# (src/api.ts, src/api/actions.ts). It must stay empty: an absolute API origin
# is cross-origin by definition here, so a supplied value is rejected instead of
# silently producing a bundle the production CSP blocks.
ARG VITE_API_BASE_URL=""
RUN if [ -n "$VITE_API_BASE_URL" ]; then \
      echo "VITE_API_BASE_URL must be empty: the bundle is served same-origin by nginx (CSP connect-src 'self')" >&2; \
      exit 1; \
    fi
ENV VITE_API_BASE_URL="${VITE_API_BASE_URL}"

# Build in dependency order: contracts first (web imports its types), then the
# web bundle. fix-esm-imports adds the `.js` extensions Node.js ESM requires.
RUN cd packages/contracts && pnpm exec tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist
RUN cd apps/web && pnpm exec tsc -p tsconfig.json && pnpm exec vite build

# ---- Stage 4: Production Web image ----
# SECURITY: pin to a specific patch version to avoid unexpected upstream updates.
# For maximum supply-chain assurance, replace with an image digest
# (FROM nginx:1.x.x-alpine@sha256:<digest>).
FROM nginx:1.27.4-alpine AS production
RUN addgroup -g 1001 commander \
    && adduser -u 1001 -G commander -s /bin/sh -D commander \
    && chown -R commander:commander /var/cache/nginx /var/log/nginx /etc/nginx/conf.d \
    && touch /var/run/nginx.pid \
    && chown commander:commander /var/run/nginx.pid
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
USER commander
CMD ["nginx", "-g", "daemon off;"]
