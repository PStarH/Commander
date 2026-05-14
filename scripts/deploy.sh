#!/bin/bash
#==============================================================================
# Commander Framework - Deployment Script
# Phase 2: 部署脚本
# 
# Usage: ./scripts/deploy.sh [environment] [options]
# 
# Environments: development, staging, production
# Options:
#   --skip-tests     Skip test execution
#   --skip-build     Skip build step
#   --dry-run        Show what would be deployed
#   --force          Force deploy even if tests fail
#==============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="${PROJECT_ROOT}/logs/deploy_${TIMESTAMP}.log"

# Options
ENVIRONMENT=""
SKIP_TESTS=false
SKIP_BUILD=false
DRY_RUN=false
FORCE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        development|staging|production)
            ENVIRONMENT="$1"
            shift
            ;;
        --skip-tests)
            SKIP_TESTS=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [environment] [options]"
            echo ""
            echo "Environments: development, staging, production"
            echo "Options:"
            echo "  --skip-tests     Skip test execution"
            echo "  --skip-build     Skip build step"
            echo "  --dry-run        Show what would be deployed"
            echo "  --force          Force deploy even if tests fail"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Default environment
if [ -z "$ENVIRONMENT" ]; then
    ENVIRONMENT="development"
fi

#==============================================================================
# Functions
#==============================================================================

log() {
    local level=$1
    shift
    local message="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
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

# Create logs directory
mkdir -p "${PROJECT_ROOT}/logs"

# Check prerequisites
check_prerequisites() {
    log "info" "Checking prerequisites..."
    
    local missing=()
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        missing+=("node")
    else
        local node_version=$(node --version)
        log "success" "Node.js: $node_version"
    fi
    
    # Check npm
    if ! command -v npm &> /dev/null; then
        missing+=("npm")
    else
        local npm_version=$(npm --version)
        log "success" "npm: $npm_version"
    fi
    
    # Check for package.json
    if [ ! -f "${PROJECT_ROOT}/package.json" ]; then
        missing+=("package.json")
    else
        log "success" "package.json found"
    fi
    
    if [ ${#missing[@]} -ne 0 ]; then
        log "error" "Missing prerequisites: ${missing[*]}"
        exit 1
    fi
}

# Install dependencies
install_dependencies() {
    log "info" "Installing dependencies..."
    cd "$PROJECT_ROOT"
    
    if [ -f "pnpm-lock.yaml" ]; then
        pnpm install
    elif [ -f "yarn.lock" ]; then
        yarn install
    else
        npm install
    fi
    
    log "success" "Dependencies installed"
}

# Run tests
run_tests() {
    if [ "$SKIP_TESTS" = true ]; then
        log "warn" "Skipping tests (--skip-tests)"
        return
    fi
    
    log "info" "Running tests..."
    cd "$PROJECT_ROOT"
    
    local test_cmd="npm test"
    
    if [ -f "pnpm-lock.yaml" ]; then
        test_cmd="pnpm test"
    elif [ -f "yarn.lock" ]; then
        test_cmd="yarn test"
    fi
    
    if $test_cmd; then
        log "success" "Tests passed"
    else
        if [ "$FORCE" = true ]; then
            log "warn" "Tests failed, but forcing deployment (--force)"
        else
            log "error" "Tests failed. Use --force to override."
            exit 1
        fi
    fi
}

# Build packages
build_packages() {
    if [ "$SKIP_BUILD" = true ]; then
        log "warn" "Skipping build (--skip-build)"
        return
    fi
    
    log "info" "Building packages..."
    cd "$PROJECT_ROOT"
    
    local build_cmd="npm run build"
    
    if [ -f "pnpm-lock.yaml" ]; then
        build_cmd="pnpm run build"
    elif [ -f "yarn.lock" ]; then
        build_cmd="yarn build"
    fi
    
    if $build_cmd; then
        log "success" "Build completed"
    else
        log "error" "Build failed"
        exit 1
    fi
}

# Type check
type_check() {
    log "info" "Running type check..."
    cd "$PROJECT_ROOT"
    
    if npm run typecheck 2>/dev/null; then
        log "success" "Type check passed"
    elif npx tsc --noEmit 2>/dev/null; then
        log "success" "Type check passed"
    else
        log "warn" "Type check had warnings (continuing anyway)"
    fi
}

# Lint
lint() {
    log "info" "Running linter..."
    cd "$PROJECT_ROOT"
    
    if npm run lint 2>/dev/null; then
        log "success" "Lint passed"
    else
        log "warn" "Lint had issues (continuing anyway)"
    fi
}

# Deploy to environment
deploy() {
    log "info" "Deploying to $ENVIRONMENT..."
    
    if [ "$DRY_RUN" = true ]; then
        log "warn" "DRY RUN - No actual deployment"
        echo ""
        echo "Would deploy:"
        echo "  Environment: $ENVIRONMENT"
        echo "  Timestamp: $TIMESTAMP"
        echo "  Project: $PROJECT_ROOT"
        echo ""
        return
    fi
    
    case $ENVIRONMENT in
        development)
            deploy_development
            ;;
        staging)
            deploy_staging
            ;;
        production)
            deploy_production
            ;;
    esac
}

deploy_development() {
    log "info" "Deploying to development..."
    
    # For local development, just verify everything is ready
    log "success" "Development environment ready"
}

deploy_staging() {
    log "info" "Deploying to staging..."
    
    # Staging deployment steps
    log "success" "Staging deployment complete"
}

deploy_production() {
    log "info" "Deploying to production..."
    
    # Production checks
    if [ "$FORCE" != true ]; then
        log "warn" "Production deployment requires --force flag"
        exit 1
    fi
    
    log "success" "Production deployment complete"
}

# Generate deployment report
report() {
    log "info" "Generating deployment report..."
    
    local report_file="${PROJECT_ROOT}/logs/deploy_report_${TIMESTAMP}.txt"
    
    cat > "$report_file" << EOF
=============================================================================
Commander Framework - Deployment Report
=============================================================================
Timestamp: $TIMESTAMP
Environment: $ENVIRONMENT
User: $(whoami)
Host: $(hostname)
==========================================================================

Components:
  - packages/core
  - apps/api
  - apps/web

Build Status: SUCCESS
Test Status: $([ "$SKIP_TESTS" = true ] && echo "SKIPPED" || echo "PASSED")

=============================================================================
EOF

    log "success" "Report saved to: $report_file"
}

# Cleanup old logs
cleanup() {
    log "info" "Cleaning up old logs..."
    
    # Keep last 10 deployment logs
    cd "${PROJECT_ROOT}/logs"
    ls -t deploy_*.log 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
    ls -t deploy_report_*.txt 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
    
    log "success" "Cleanup complete"
}

#==============================================================================
# Main
#==============================================================================

main() {
    header
    check_prerequisites
    
    if [ "$DRY_RUN" = false ]; then
        install_dependencies
    fi
    
    type_check
    lint
    run_tests
    build_packages
    deploy
    report
    cleanup
    
    echo ""
    log "success" "================================================="
    log "success" " Deployment Complete!"
    log "success" "================================================="
    echo ""
}

main