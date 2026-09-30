FROM node:22-alpine
WORKDIR /app

# Minimal HTTP server used by api/worker/kernel-ops/adapter-ops health/readiness probes.
COPY server.js ./

# No-op scripts matching the chart's migration/proof Job commands.
COPY migrationGate.js packages/kernel/dist/
COPY migrate.js packages/kernel/dist/

EXPOSE 4000 8081 8082 8083
CMD ["node", "server.js"]
