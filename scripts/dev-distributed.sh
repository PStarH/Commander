#!/bin/bash
#==============================================================================
# Commander — Local Distributed Development Orchestration
#
# Brings up a full V2 distributed stack on a single machine:
#   1. PostgreSQL (via docker-compose database profile)
#   2. Schema migrations (packages/kernel/src/schema.ts)
#   3. API server in V2 mode (pnpm dev:api)
#   4. Worker process (packages/worker-plane/src/bootstrap.ts)
#   5. [optional] Observability stack (Prometheus + Grafana)
#
# Usage:
#   ./scripts/dev-distributed.sh                    # Start full stack
#   ./scripts/dev-distributed.sh --clean            # Reset database, then start
#   ./scripts/dev-distributed.sh --observability    # Also start Prometheus + Grafana
#   ./scripts/dev-distributed.sh --clean --observability
#
# Environment (all optional — sensible dev defaults provided):
#   DATABASE_URL                     PostgreSQL connection string
#   COMMANDER_API_KEY                API authentication key
#   COMMANDER_WORKER_AUTH_TOKEN      Worker authentication token
#   COMMANDER_WORKER_KIND            Worker type (default: agent)
#   COMMANDER_WORKER_MAX_CONCURRENCY Max concurrent steps (default: 10)
#   OPENAI_API_KEY / ANTHROPIC_API_KEY  LLM provider keys
#
# Health check URLs are printed once the stack is up.
# Press Ctrl-C to stop — child processes are cleaned up automatically.
#==============================================================================

set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# ── Configuration ────────────────────────────────────────────────────────────
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

DB_USER="${POSTGRES_USER:-commander}"
DB_PASS="${POSTGRES_PASSWORD:-commander}"
DB_NAME="${POSTGRES_DB:-commander}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_URL="${DATABASE_URL:-postgres://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}}"

API_PORT="${PORT:-4000}"
WEB_PORT="${WEB_PORT:-3000}"
PROMETHEUS_PORT="${PROMETHEUS_PORT:-9090}"
GRAFANA_PORT="${GRAFANA_PORT:-3001}"

OBSERVABILITY=false
CLEAN=false
LOG_DIR="${PROJECT_ROOT}/logs"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
API_LOG="${LOG_DIR}/dev-distributed_api_${TIMESTAMP}.log"
WORKER_LOG="${LOG_DIR}/dev-distributed_worker_${TIMESTAMP}.log"

# ── Track child PIDs for cleanup ─────────────────────────────────────────────
CHILD_PIDS=()
DOCKER_STARTED=false

#==============================================================================
# Logging helpers
#==============================================================================
log() {
    local level="$1"; shift
    local color="$NC"
    case "$level" in
        info)    color="$BLUE"   ;;
        success) color="$GREEN"  ;;
        warn)    color="$YELLOW" ;;
        error)   color="$RED"    ;;
        step)    color="$CYAN"   ;;
    esac
    local ts
    ts=$(date '+%H:%M:%S')
    echo -e "${color}[${ts}] [${level}]${NC} ${BOLD}$*${NC}"
}

header() {
    echo ""
    echo -e "  ${BOLD}${BLUE}┌──────────────────────────────────────────────────────┐${NC}"
    echo -e "  ${BOLD}${BLUE}│${NC}  ${BOLD}Commander — Distributed Dev Environment${NC}        ${BOLD}${BLUE}│${NC}"
    echo -e "  ${BOLD}${BLUE}└──────────────────────────────────────────────────────┘${NC}"
    echo ""
}

#==============================================================================
# Cleanup — kill child processes on exit
#==============================================================================
cleanup() {
    local exit_code=$?
    echo ""
    log "info" "Shutting down..."

    # Terminate child processes (API server, worker)
    # Use ${array[@]+"${array[@]}"} to safely handle empty arrays with set -u
    for pid in ${CHILD_PIDS[@]+"${CHILD_PIDS[@]}"}; do
        if kill -0 "$pid" 2>/dev/null; then
            log "info" "Stopping process ${pid}..."
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done

    # Wait briefly for graceful shutdown, then force-kill
    sleep 1
    for pid in ${CHILD_PIDS[@]+"${CHILD_PIDS[@]}"}; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done

    # With --clean, tear down Docker containers (PostgreSQL + observability)
    # so no state persists between runs. Without --clean, containers are left
    # running for data persistence across restarts.
    if [ "$CLEAN" = true ] && [ "$DOCKER_STARTED" = true ]; then
        log "warn" "--clean: tearing down Docker containers..."
        if [ "$OBSERVABILITY" = true ]; then
            docker compose --profile database --profile observability down --volumes 2>/dev/null || true
        else
            docker compose --profile database down --volumes 2>/dev/null || true
        fi
        log "success" "Docker containers and volumes removed (--clean)"
    else
        log "success" "Dev processes stopped. Docker containers left running."
        log "info" "Stop Docker manually: docker compose --profile database --profile observability down"
    fi

    log "info" "API log:      ${API_LOG}"
    log "info" "Worker log:   ${WORKER_LOG}"
    echo ""
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

#==============================================================================
# Argument parsing
#==============================================================================
print_usage() {
    cat << EOF
Usage: $0 [options]

Options:
  --clean           Reset the database at startup AND tear down Docker
                    containers on exit (no state persists between runs)
  --observability   Start Prometheus + Grafana monitoring stack
  --help, -h        Show this help message

Environment variables (all optional):
  DATABASE_URL                     PostgreSQL connection string
  COMMANDER_API_KEY                API authentication key
  COMMANDER_WORKER_AUTH_TOKEN      Worker authentication token
  COMMANDER_WORKER_KIND            Worker type (default: agent)
  COMMANDER_WORKER_MAX_CONCURRENCY Max concurrent steps (default: 10)
  OPENAI_API_KEY / ANTHROPIC_API_KEY  LLM provider keys

Examples:
  $0                                   Start the full V2 stack
  $0 --clean                           Reset DB and start fresh
  $0 --clean --observability           Reset DB + start monitoring
EOF
}

for arg in "$@"; do
    case "$arg" in
        --clean)
            CLEAN=true
            ;;
        --observability)
            OBSERVABILITY=true
            ;;
        --help|-h)
            print_usage
            exit 0
            ;;
        *)
            echo -e "  ${RED}Unknown option: ${arg}${NC}"
            print_usage
            exit 1
            ;;
    esac
done

#==============================================================================
# Prerequisites check
#==============================================================================
check_prerequisites() {
    log "step" "Checking prerequisites..."

    local missing=()

    if ! command -v docker &> /dev/null; then
        missing+=("docker")
    fi
    if ! docker compose version &> /dev/null; then
        missing+=("docker-compose-v2")
    fi
    if ! command -v node &> /dev/null; then
        missing+=("node")
    fi
    if ! command -v pnpm &> /dev/null; then
        missing+=("pnpm")
    fi
    if ! command -v npx &> /dev/null; then
        missing+=("npx")
    fi

    if [ ${#missing[@]} -ne 0 ]; then
        log "error" "Missing prerequisites: ${missing[*]}"
        log "info" "Install Docker: https://docs.docker.com/get-docker/"
        log "info" "Install Node.js: https://nodejs.org/"
        log "info" "Install pnpm: npm install -g pnpm"
        exit 1
    fi

    if [ ! -f "${PROJECT_ROOT}/docker-compose.yml" ]; then
        log "error" "docker-compose.yml not found at project root"
        exit 1
    fi

    if [ ! -f "${PROJECT_ROOT}/package.json" ]; then
        log "error" "package.json not found — run from the Commander project root"
        exit 1
    fi

    log "success" "Node $(node --version), pnpm $(pnpm --version), Docker OK"
}

#==============================================================================
# Step 1: Start PostgreSQL
#==============================================================================
start_postgres() {
    log "step" "Starting PostgreSQL via docker-compose (database profile)..."

    # Export DB credentials for docker-compose substitution
    export POSTGRES_USER="$DB_USER"
    export POSTGRES_PASSWORD="$DB_PASS"
    export POSTGRES_DB="$DB_NAME"

    if [ "$CLEAN" = true ]; then
        log "warn" "--clean: resetting database..."
        docker compose --profile database stop postgres 2>/dev/null || true
        docker compose --profile database rm -f -v postgres 2>/dev/null || true
        # Remove the named volume to force a fresh database
        docker volume rm commander_postgres-data 2>/dev/null || true
        log "success" "Database volume removed"
    fi

    docker compose --profile database up -d postgres
    DOCKER_STARTED=true
    log "success" "PostgreSQL container started"
}

#==============================================================================
# Step 2: Wait for PostgreSQL to be ready
#==============================================================================
wait_for_postgres() {
    log "step" "Waiting for PostgreSQL to accept connections..."

    local max_retries=30
    local retry=0
    local ready=false

    while [ $retry -lt $max_retries ]; do
        # Use docker exec to run pg_isready inside the container
        if docker exec commander-postgres pg_isready -U "$DB_USER" -d "$DB_NAME" &> /dev/null; then
            ready=true
            break
        fi
        retry=$((retry + 1))
        printf "  ${DIM}waiting for postgres... attempt %d/%d${NC}\r" "$retry" "$max_retries"
        sleep 2
    done
    echo ""

    if [ "$ready" = false ]; then
        log "error" "PostgreSQL did not become ready after ${max_retries} attempts"
        log "info" "Check logs: docker logs commander-postgres"
        exit 1
    fi

    log "success" "PostgreSQL is ready (took $((retry * 2))s)"

    # Export DATABASE_URL for downstream processes
    export DATABASE_URL="$DB_URL"
    export API_STORE_BACKEND=postgres
}

#==============================================================================
# Step 3: Run kernel migration job
#==============================================================================
run_migrations() {
    log "step" "Running kernel migration job..."

    if [ ! -f "${PROJECT_ROOT}/packages/kernel/src/migrate.ts" ]; then
        log "warn" "packages/kernel/src/migrate.ts not found — skipping migrations"
        return
    fi

    if DATABASE_URL="$DB_URL" pnpm exec tsx packages/kernel/src/migrate.ts; then
        log "success" "Kernel migrations applied"
    else
        log "error" "Kernel migration job failed — refusing to start API replicas"
        exit 1
    fi
}

#==============================================================================
# Step 4: Start API server in V2 mode
#==============================================================================
start_api() {
    log "step" "Starting API server (V2 mode)..."

    # Set required environment for V2 distributed mode
    export COMMANDER_V2_MODE=1
    export COMMANDER_KERNEL_ENABLED=1
    export NODE_ENV=development
    export DATABASE_URL="$DB_URL"
    export API_STORE_BACKEND=postgres
    export PORT="$API_PORT"
    export COMMANDER_API_KEY="${COMMANDER_API_KEY:-dev-api-key-please-change}"
    export COMMANDER_EVENT_BUS_BACKEND="${COMMANDER_EVENT_BUS_BACKEND:-memory}"

    # Pass through LLM provider keys if set
    # (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc. are inherited from the environment)

    pnpm dev:api > "$API_LOG" 2>&1 &
    local api_pid=$!
    CHILD_PIDS+=("$api_pid")
    log "success" "API server started (PID ${api_pid}, port ${API_PORT})"
    log "info" "API log: ${API_LOG}"
}

#==============================================================================
# Step 5: Start worker process
#==============================================================================
start_worker() {
    log "step" "Starting worker process (V2 mode)..."

    # Worker-specific environment
    export COMMANDER_V2_MODE=1
    export COMMANDER_KERNEL_ENABLED=1
    export DATABASE_URL="$DB_URL"
    export COMMANDER_WORKER_AUTH_TOKEN="${COMMANDER_WORKER_AUTH_TOKEN:-dev-worker-token}"
    export COMMANDER_WORKER_KIND="${COMMANDER_WORKER_KIND:-agent}"
    export COMMANDER_WORKER_MAX_CONCURRENCY="${COMMANDER_WORKER_MAX_CONCURRENCY:-10}"
    export COMMANDER_WORKER_HEARTBEAT_MS="${COMMANDER_WORKER_HEARTBEAT_MS:-10000}"
    export COMMANDER_WORKER_POLL_MS="${COMMANDER_WORKER_POLL_MS:-250}"
    export COMMANDER_WORKER_ID="${COMMANDER_WORKER_ID:-dev-worker-1}"

    npx tsx packages/worker-plane/src/bootstrap.ts > "$WORKER_LOG" 2>&1 &
    local worker_pid=$!
    CHILD_PIDS+=("$worker_pid")
    log "success" "Worker started (PID ${worker_pid}, kind=${COMMANDER_WORKER_KIND})"
    log "info" "Worker log: ${WORKER_LOG}"
}

#==============================================================================
# Step 6: Optionally start observability stack
#==============================================================================
start_observability() {
    if [ "$OBSERVABILITY" = false ]; then
        return
    fi

    log "step" "Starting observability stack (Prometheus + Grafana)..."

    docker compose --profile observability up -d prometheus grafana

    log "success" "Prometheus started (port ${PROMETHEUS_PORT})"
    log "success" "Grafana started (port ${GRAFANA_PORT})"
}

#==============================================================================
# Step 7: Wait for API health, then print summary
#==============================================================================
wait_for_api_and_print_summary() {
    log "step" "Waiting for API server to become healthy..."

    local max_retries=30
    local retry=0
    local healthy=false

    while [ $retry -lt $max_retries ]; do
        if curl -sf "http://localhost:${API_PORT}/health" > /dev/null 2>&1; then
            healthy=true
            break
        fi
        retry=$((retry + 1))
        printf "  ${DIM}waiting for API... attempt %d/%d${NC}\r" "$retry" "$max_retries"
        sleep 2
    done
    echo ""

    if [ "$healthy" = true ]; then
        log "success" "API server is healthy"
    else
        log "warn" "API health check timed out — server may still be starting"
        log "info" "Check API log: tail -f ${API_LOG}"
    fi

    # ── Print summary ────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}${GREEN}════════════════════════════════════════════════════════════${NC}"
    echo -e "  ${BOLD}${GREEN}  Commander Distributed Dev Stack — Ready${NC}"
    echo -e "  ${BOLD}${GREEN}════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${BOLD}Health Check URLs:${NC}"
    echo -e "    ${CYAN}API health${NC}        http://localhost:${API_PORT}/health"
    echo -e "    ${CYAN}API metrics${NC}       http://localhost:${API_PORT}/metrics"
    echo -e "    ${CYAN}PostgreSQL${NC}        localhost:${DB_PORT} (${DB_USER}/${DB_NAME})"
    if [ "$OBSERVABILITY" = true ]; then
        echo -e "    ${CYAN}Prometheus${NC}       http://localhost:${PROMETHEUS_PORT}"
        echo -e "    ${CYAN}Grafana${NC}           http://localhost:${GRAFANA_PORT} (admin / ${GRAFANA_ADMIN_PASSWORD:-admin})"
    fi
    echo ""
    echo -e "  ${BOLD}Useful Commands:${NC}"
    echo -e "    ${DIM}View API logs${NC}       tail -f ${API_LOG}"
    echo -e "    ${DIM}View worker logs${NC}    tail -f ${WORKER_LOG}"
    echo -e "    ${DIM}psql shell${NC}          docker exec -it commander-postgres psql -U ${DB_USER} -d ${DB_NAME}"
    echo -e "    ${DIM}Run diagnostics${NC}     npx tsx packages/core/src/cli.ts diagnose"
    echo -e "    ${DIM}Stop stack${NC}          Ctrl-C (or kill ${CHILD_PIDS[@]+"${CHILD_PIDS[*]}"})"
    echo -e "    ${DIM}Stop Docker${NC}         docker compose --profile database --profile observability down"
    if [ "$OBSERVABILITY" = true ]; then
        echo -e "    ${DIM}Reset data${NC}         $0 --clean"
    else
        echo -e "    ${DIM}Reset data${NC}         $0 --clean"
    fi
    echo ""
    echo -e "  ${DIM}Press Ctrl-C to stop the dev stack.${NC}"
    if [ "$CLEAN" = true ]; then
        echo -e "  ${DIM}--clean: Docker containers will be torn down on exit.${NC}"
    else
        echo -e "  ${DIM}Docker containers (PostgreSQL${OBSERVABILITY:+, Prometheus, Grafana}) remain running for data persistence.${NC}"
    fi
    echo ""
}

#==============================================================================
# Main
#==============================================================================
main() {
    header
    check_prerequisites
    start_postgres
    wait_for_postgres
    run_migrations
    start_observability
    start_api
    start_worker
    wait_for_api_and_print_summary

    # Keep script alive — wait for child processes
    # If any child exits, we stop the whole stack
    log "info" "Stack is running. Waiting for child processes..."
    local any_exited=false
    for pid in ${CHILD_PIDS[@]+"${CHILD_PIDS[@]}"}; do
        if ! wait "$pid" 2>/dev/null; then
            any_exited=true
        fi
    done

    if [ "$any_exited" = true ]; then
        log "warn" "A child process exited. Check the logs above."
        log "info" "API log:   tail -f ${API_LOG}"
        log "info" "Worker log: tail -f ${WORKER_LOG}"
    fi
}

main
