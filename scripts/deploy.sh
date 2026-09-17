#!/bin/bash
#==============================================================================
# Commander Framework - Deployment Script
#
# Usage: ./scripts/deploy.sh [environment] [options]
#
# Environments: development, staging, production
#
# Options:
#   --skip-tests           Skip test execution (makes the run diagnostic-only)
#   --skip-build           Skip build (makes the run diagnostic-only)
#   --dry-run              Show what would be deployed
#   --confirm-production   Confirm a production deployment (required for production)
#   --allow-gate-failure   Diagnostic mode: keep collecting after a failed stage,
#                          but never deploy and always exit non-zero
#   --help, -h             Show this help
#
# This script reports REAL stage results. A stage that did not run is reported
# as NOT_RUN, a stage that failed is reported as FAILED, and neither can be
# rendered as PASSED. There is no flag that converts a failed security or test
# gate into a successful deployment: `--force` was removed for exactly that
# reason and is rejected with guidance.
#
# The report is derived from the stage status map, not written by hand.
#==============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="${PROJECT_ROOT}/logs/deploy_${TIMESTAMP}.log"

# Production runs the standalone, digest-pinned compose file. The development
# base (docker-compose.yml) is NEVER merged in: it carries `build:` stanzas,
# which rebuild images on this host from whatever source is present instead of
# deploying the candidate that was tested, and it publishes port 4000 directly
# on the host.
PROD_COMPOSE_FILE="docker-compose.prod.yml"

# Options
ENVIRONMENT=""
SKIP_TESTS=false
SKIP_BUILD=false
DRY_RUN=false
CONFIRM_PRODUCTION=false
ALLOW_GATE_FAILURE=false

# Stage model. A stage is NOT_RUN until it is begun, and only ever becomes
# RUNNING -> PASSED | FAILED | SKIPPED.
# One plain variable per stage, read back with indirect expansion: `declare -A`
# needs bash 4 and macOS ships bash 3.2, so an associative array made this
# script unrunnable on the machine it is developed and smoke-tested on. The
# deployment target is Linux bash 5; both must work.
STAGE_dependencies=NOT_RUN
STAGE_typecheck=NOT_RUN
STAGE_lint=NOT_RUN
STAGE_tests=NOT_RUN
STAGE_build=NOT_RUN
STAGE_deploy=NOT_RUN
STAGE_health=NOT_RUN
STAGE_ORDER=(dependencies typecheck lint tests build deploy health)
# Stages that must be PASSED before anything is deployed.
REQUIRED_STAGES=(typecheck tests build)

stage_status() {
    local name="STAGE_$1"
    printf '%s' "${!name}"
}
stage_set()   { printf -v "STAGE_$1" '%s' "$2"; }
stage_begin() { stage_set "$1" RUNNING; }
stage_pass()  { stage_set "$1" PASSED; }
stage_skip()  { stage_set "$1" SKIPPED; }
stage_fail()  { stage_set "$1" FAILED; }

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        development|staging|production)
            ENVIRONMENT="$1"
            shift
            ;;
        --skip-tests)   SKIP_TESTS=true; shift ;;
        --skip-build)   SKIP_BUILD=true; shift ;;
        --dry-run)      DRY_RUN=true; shift ;;
        --confirm-production) CONFIRM_PRODUCTION=true; shift ;;
        --allow-gate-failure) ALLOW_GATE_FAILURE=true; shift ;;
        --force)
            echo "ERROR: --force was removed." >&2
            echo "       It used to mean 'ignore test failures', which silently produced a" >&2
            echo "       report that claimed tests PASSED. Use --confirm-production to confirm a" >&2
            echo "       production deployment, or --allow-gate-failure for a diagnostic run that" >&2
            echo "       never deploys and always exits non-zero." >&2
            exit 2
            ;;
        --help|-h)
            sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 2
            ;;
    esac
done

if [ -z "$ENVIRONMENT" ]; then
    ENVIRONMENT="development"
fi

#==============================================================================
# Logging
#==============================================================================

mkdir -p "${PROJECT_ROOT}/logs"

log() {
    local level=$1
    shift
    local message="$*"
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local color=$NC
    case $level in
        info)    color=$BLUE ;;
        success) color=$GREEN ;;
        warn)    color=$YELLOW ;;
        error)   color=$RED ;;
    esac
    echo -e "${color}[${timestamp}] [${level}] ${message}${NC}"
    echo "[${timestamp}] [${level}] ${message}" >> "$LOG_FILE"
}

header() {
    echo ""
    log "info" "================================================="
    log "info" " Commander Framework Deployment"
    log "info" " Environment: $ENVIRONMENT"
    log "info" " Timestamp: $TIMESTAMP"
    log "info" "================================================="
    echo ""
}

#==============================================================================
# Stage evaluation
#==============================================================================

# Render the deployment report body from the stage status map.
# Reads the stage variables via stage_status; writes to stdout. Never writes a
# status by hand.
render_report() {
    local overall="$1"
    cat <<EOF
=============================================================================
Commander Framework - Deployment Report
=============================================================================
Timestamp: $TIMESTAMP
Environment: $ENVIRONMENT
User: $(whoami)
Host: $(hostname)
Mode: $([ "$DRY_RUN" = true ] && echo "DRY-RUN" || echo "REAL")
=============================================================================

Components:
  - packages/core
  - apps/api
  - apps/web

Stage results:
  Dependencies:  $(stage_status dependencies)
  Typecheck:     $(stage_status typecheck)
  Lint:          $(stage_status lint)
  Tests:         $(stage_status tests)
  Build:         $(stage_status build)
  Deploy:        $(stage_status deploy)
  Health:        $(stage_status health)

Overall: $overall
=============================================================================
EOF
}

# A run is deployable only when every required stage PASSED and nothing FAILED.
# SKIPPED is not PASSED: a skipped required gate is not evidence.
evaluate_overall() {
    local stage
    for stage in "${STAGE_ORDER[@]}"; do
        if [ "$(stage_status "$stage")" = "FAILED" ]; then
            echo "FAILED"
            return 0
        fi
    done
    for stage in "${REQUIRED_STAGES[@]}"; do
        if [ "$(stage_status "$stage")" != "PASSED" ]; then
            echo "NOT_DEPLOYED"
            return 0
        fi
    done
    if [ "$(stage_status deploy)" = "PASSED" ] && [ "$(stage_status health)" = "PASSED" ]; then
        echo "PASSED"
    else
        echo "NOT_DEPLOYED"
    fi
}

#==============================================================================
# Stages
#==============================================================================

check_prerequisites() {
    log "info" "Checking prerequisites..."
    local missing=()
    command -v node > /dev/null || missing+=("node")
    command -v pnpm > /dev/null || missing+=("pnpm")
    [ -f "${PROJECT_ROOT}/package.json" ] || missing+=("package.json")
    [ -f "${PROJECT_ROOT}/pnpm-lock.yaml" ] || missing+=("pnpm-lock.yaml")
    if [ ${#missing[@]} -ne 0 ]; then
        log "error" "Missing prerequisites: ${missing[*]}"
        return 1
    fi
    log "success" "Prerequisites present (node $(node --version), pnpm $(pnpm --version))"
}

install_dependencies() {
    stage_begin dependencies
    log "info" "Installing dependencies (frozen lockfile)..."
    cd "$PROJECT_ROOT"
    # Frozen lockfile only. No npm/yarn fallback: a different resolver is a
    # different dependency graph, and this run cannot be attested as the
    # candidate that was tested.
    if pnpm install --frozen-lockfile; then
        stage_pass dependencies
        log "success" "Dependencies installed"
    else
        stage_fail dependencies
        log "error" "Dependency installation failed"
        return 1
    fi
}

run_tests() {
    if [ "$SKIP_TESTS" = true ]; then
        stage_skip tests
        log "warn" "Skipping tests (--skip-tests): the run is not deployable"
        return 0
    fi
    stage_begin tests
    log "info" "Running tests..."
    cd "$PROJECT_ROOT"
    if pnpm test; then
        stage_pass tests
        log "success" "Tests passed"
    else
        stage_fail tests
        log "error" "Tests FAILED"
        return 1
    fi
}

build_packages() {
    if [ "$SKIP_BUILD" = true ]; then
        stage_skip build
        log "warn" "Skipping build (--skip-build): the run is not deployable"
        return 0
    fi
    stage_begin build
    log "info" "Building packages..."
    cd "$PROJECT_ROOT"
    if pnpm run build; then
        stage_pass build
        log "success" "Build completed"
    else
        stage_fail build
        log "error" "Build FAILED"
        return 1
    fi
}

type_check() {
    stage_begin typecheck
    log "info" "Running type check..."
    cd "$PROJECT_ROOT"
    if pnpm run typecheck; then
        stage_pass typecheck
        log "success" "Type check passed"
    else
        stage_fail typecheck
        log "error" "Type check FAILED"
        return 1
    fi
}

lint() {
    stage_begin lint
    log "info" "Running linter..."
    cd "$PROJECT_ROOT"
    if pnpm run lint; then
        stage_pass lint
        log "success" "Lint passed"
    else
        # Lint is not a required gate for deployment, but it is still recorded
        # truthfully and never rendered as passed.
        stage_fail lint
        log "warn" "Lint reported issues (recorded as FAILED; not a required gate)"
        return 0
    fi
}

#==============================================================================
# Deployment
#==============================================================================

# Readiness of the production API, observed from INSIDE the api container.
# docker-compose.prod.yml publishes no host port for the API (only the 9443
# tenant-authority proof port, on the compose network), so a host-side
# `curl http://localhost:4000/health` can never succeed — the previous check
# failed correct deployments.
#
# `/ready` is the readiness gate: HTTP 200 only when the hard dependency probes
# pass, 503 otherwise. `/health` is liveness and its `status=ok` body is not a
# readiness signal. The fetch is bounded by an AbortController so a hung socket
# cannot stall the retry loop.
API_READY_JS="const ac=new AbortController();const t=setTimeout(()=>ac.abort(),3000);fetch('http://127.0.0.1:4000/ready',{signal:ac.signal}).then(r=>{clearTimeout(t);process.exit(r.status===200?0:1)}).catch(()=>process.exit(1));"

api_ready() {
    docker compose -f "$PROD_COMPOSE_FILE" exec -T api node -e "$API_READY_JS" > /dev/null 2>&1
}

wait_for_health() {
    stage_begin health
    local retries=0
    local max_retries=30
    while [ $retries -lt $max_retries ]; do
        if api_ready; then
            stage_pass health
            log "success" "API readiness passed (/ready returned HTTP 200 inside the api container)"
            return 0
        fi
        retries=$((retries + 1))
        sleep 2
    done
    stage_fail health
    log "error" "Readiness FAILED: /ready did not return HTTP 200 inside the api container after ${max_retries} attempts"
    return 1
}

# `.env.example` ships placeholder credentials; deploying it is a launch blocker.
# A copy under another name is the same file, so the check is by content as well
# as by value.
WEAK_SECRET_PATTERNS=(
    '^COMMANDER_API_KEY=change-me-to-a-random-secret$'
    '^GRAFANA_ADMIN_PASSWORD=admin$'
)

# Echoes a reason when the env file is not production-grade; no output and a
# non-zero status when it is acceptable.
env_file_secret_problem() {
    local file="$1" pattern
    if [ -f "${PROJECT_ROOT}/.env.example" ] && cmp -s "$file" "${PROJECT_ROOT}/.env.example"; then
        echo "it is a copy of .env.example"
        return 0
    fi
    for pattern in "${WEAK_SECRET_PATTERNS[@]}"; do
        if grep -qE "$pattern" "$file"; then
            echo "it still contains the placeholder '$pattern'"
            return 0
        fi
    done
    return 1
}

deploy() {
    if [ "$DRY_RUN" = true ]; then
        stage_skip deploy
        log "warn" "DRY RUN - No actual deployment"
        return 0
    fi
    stage_begin deploy
    log "info" "Deploying to $ENVIRONMENT..."
    case $ENVIRONMENT in
        development) log "success" "Development environment ready" ;;
        staging)     log "success" "Staging deployment complete" ;;
        production)  deploy_production || { stage_fail deploy; return 1; } ;;
    esac
    stage_pass deploy
}

deploy_production() {
    if [ "$CONFIRM_PRODUCTION" != true ]; then
        log "error" "Production deployment requires --confirm-production"
        return 1
    fi
    command -v docker > /dev/null || { log "error" "Docker is required for production deployment"; return 1; }
    if ! docker compose version > /dev/null 2>&1; then
        log "error" "Docker Compose v2 is required for production deployment"
        return 1
    fi
    [ -f "${PROJECT_ROOT}/${PROD_COMPOSE_FILE}" ] || {
        log "error" "Missing ${PROD_COMPOSE_FILE}"
        return 1
    }
    [ -f "${PROJECT_ROOT}/.env" ] || {
        log "error" "Missing .env file. Provide a real production environment file with generated secrets — .env.example is not production configuration."
        return 1
    }
    local problem
    if problem="$(env_file_secret_problem "${PROJECT_ROOT}/.env")"; then
        log "error" "Refusing to deploy: ${problem}. Generate real secrets (openssl rand -hex 32) before deploying."
        return 1
    fi
    cd "$PROJECT_ROOT"
    # Pre-built, digest-pinned images only. No build step: building here would
    # deploy whatever source this host happens to have, not the tested candidate.
    log "info" "Pulling the pinned production images (no build on this host)..."
    docker compose -f "$PROD_COMPOSE_FILE" pull \
        || { log "error" "Failed to pull production images"; return 1; }
    log "info" "Starting production services (--no-build)..."
    docker compose -f "$PROD_COMPOSE_FILE" up -d --no-build --remove-orphans \
        || { log "error" "Failed to start production services"; return 1; }
    wait_for_health || return 1
    log "success" "Production deployment complete"
}

#==============================================================================
# Report + cleanup
#==============================================================================

report() {
    local overall="$1"
    log "info" "Generating deployment report..."
    local report_file="${PROJECT_ROOT}/logs/deploy_report_${TIMESTAMP}.txt"
    if render_report "$overall" > "$report_file"; then
        log "success" "Report saved to: $report_file"
    else
        log "error" "Failed to write deployment report"
        return 1
    fi
}

cleanup() {
    local exit_code=$?
    log "info" "Cleaning up old logs..."
    # Only this run's own resources are touched; a cleanup failure never
    # overwrites the first failure code.
    (
      cd "${PROJECT_ROOT}/logs" || exit 0
      ls -t deploy_*.log 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
      ls -t deploy_report_*.txt 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
    ) || true
    return $exit_code
}

#==============================================================================
# Main
#==============================================================================

main() {
    local failed=false

    header

    if ! check_prerequisites; then
        exit 1
    fi

    if [ "$DRY_RUN" = false ]; then
        install_dependencies || failed=true
    fi

    # Diagnostics mode keeps collecting after a failure so the operator sees the
    # whole picture. It never deploys and it always exits non-zero.
    if [ "$failed" = true ] && [ "$ALLOW_GATE_FAILURE" != true ]; then
        report "$(evaluate_overall)"
        log "error" "Required stage failed; not deploying. Use --allow-gate-failure for a diagnostic run."
        exit 1
    fi

    type_check || failed=true
    lint || true
    run_tests || failed=true
    build_packages || failed=true

    if [ "$failed" = true ]; then
        report "$(evaluate_overall)"
        log "error" "One or more required stages FAILED. No deployment was performed."
        exit 1
    fi

    deploy || failed=true

    if [ "$failed" = true ]; then
        report "$(evaluate_overall)"
        log "error" "Deployment FAILED."
        exit 1
    fi

    local overall
    overall="$(evaluate_overall)"
    report "$overall"

    if [ "$overall" != "PASSED" ]; then
        log "error" "Overall status is $overall; refusing to report success."
        exit 1
    fi

    echo ""
    log "success" "================================================="
    log "success" " Deployment Complete!"
    log "success" "================================================="
    echo ""
}

# Library-only mode: lets the contract test exercise render_report /
# evaluate_overall without running a deployment.
if [ "${COMMANDER_DEPLOY_LIB_ONLY:-}" = "1" ]; then
    return 0 2>/dev/null || exit 0
fi

trap cleanup EXIT
main
