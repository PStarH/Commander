#!/bin/bash
# =============================================================================
# Commander — VM Deployment Script
# Deploy to any Linux VM with Docker + Docker Compose
#
# Prerequisites on target VM:
#   - Docker Engine 24+
#   - Docker Compose v2
#   - Open ports: 80 (web), 4000 (API, optional)
#
# Usage:
#   ./scripts/deploy-vm.sh <host> [--user root] [--key ~/.ssh/id_rsa] [--env-file .env.production]
#
# Examples:
#   ./scripts/deploy-vm.sh 203.0.113.10 --env-file .env.production
#   ./scripts/deploy-vm.sh my-vm.example.com --user deploy --key ~/.ssh/commander-deploy
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} $1"; }
ok()   { echo -e "${GREEN}  ✓${NC} $1"; }
warn() { echo -e "${YELLOW}  ⚠${NC} $1"; }
fail() { echo -e "${RED}  ✗${NC} $1"; exit 1; }

# ── Args ──────────────────────────────────────────────────────────────────────
HOST="${1:?Usage: $0 <host> [--user root] [--key <path>] [--env-file <path>]}"
shift
SSH_USER="root"
SSH_KEY=""
ENV_FILE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --user)    SSH_USER="$2";    shift 2 ;;
    --key)     SSH_KEY="$2";     shift 2 ;;
    --env-file) ENV_FILE="$2";  shift 2 ;;
    --help|-h) echo "Usage: $0 <host> [--user root] [--key <path>] [--env-file <path>]"; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

SSH_CMD="ssh ${SSH_KEY:+-i $SSH_KEY} -o StrictHostKeyChecking=accept-new $SSH_USER@$HOST"
SCP_CMD="scp ${SSH_KEY:+-i $SSH_KEY}"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR="/opt/commander"

# ── Checks ──────────────────────────────────────────────────────────────────
log "Deploying Commander to ${GREEN}$HOST${NC} as ${GREEN}$SSH_USER${NC}"

# Check Docker on remote
log "Checking remote prerequisites..."
$SSH_CMD "docker --version && docker compose version" > /dev/null 2>&1 \
  || fail "Docker or Docker Compose not found on $HOST. Install Docker 24+ first."
ok "Docker + Docker Compose ready"

# ── Prepare remote directory ────────────────────────────────────────────────
log "Preparing remote directory..."
$SSH_CMD "mkdir -p $REMOTE_DIR/config $REMOTE_DIR/scripts"

# ── Copy files ──────────────────────────────────────────────────────────────
log "Transferring deployment files..."
$SCP_CMD "$PROJECT_ROOT/docker-compose.yml"          "$SSH_USER@$HOST:$REMOTE_DIR/"
$SCP_CMD "$PROJECT_ROOT/docker-compose.prod.yml"     "$SSH_USER@$HOST:$REMOTE_DIR/"
$SCP_CMD "$PROJECT_ROOT/Dockerfile"                   "$SSH_USER@$HOST:$REMOTE_DIR/"
$SCP_CMD "$PROJECT_ROOT/.env.example"                 "$SSH_USER@$HOST:$REMOTE_DIR/"

# Transfer config files if they exist
[[ -f "$PROJECT_ROOT/apps/web/nginx.conf" ]] && \
  $SCP_CMD "$PROJECT_ROOT/apps/web/nginx.conf"         "$SSH_USER@$HOST:$REMOTE_DIR/"

if [[ -n "$ENV_FILE" ]]; then
  log "Using env file: $ENV_FILE"
  $SCP_CMD "$ENV_FILE" "$SSH_USER@$HOST:$REMOTE_DIR/.env"
  ok "Environment file uploaded"
else
  warn "No --env-file specified. Using default .env.example. Copy to .env on remote and edit."
fi

ok "Files transferred"

# ── Build & Deploy ──────────────────────────────────────────────────────────
log "Building and deploying on remote..."
$SSH_CMD "cd $REMOTE_DIR && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build"
ok "Containers started"

# ── Health check ────────────────────────────────────────────────────────────
log "Waiting for health check..."
sleep 10
HEALTH=$($SSH_CMD "curl -s -o /dev/null -w '%{http_code}' http://localhost:4000/health" 2>/dev/null || echo "000")
if [[ "$HEALTH" == "200" ]]; then
  ok "API health check passed (HTTP $HEALTH)"
else
  warn "Health check returned HTTP $HEALTH. Check logs: docker compose -f $REMOTE_DIR/docker-compose.yml logs api"
fi

# Check web
WEB=$($SSH_CMD "curl -s -o /dev/null -w '%{http_code}' http://localhost:80/" 2>/dev/null || echo "000")
ok "Web GUI: HTTP $WEB"

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
log "${GREEN}══════════════════════════════════════════════════════════${NC}"
log "${GREEN}  Commander deployed to $HOST${NC}"
log "${GREEN}══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Web GUI:  http://$HOST/"
echo "  API:      http://$HOST:4000/"
echo "  Health:   http://$HOST:4000/health"
echo "  Metrics:  http://$HOST:4000/metrics"
echo ""
echo "  Manage:"
echo "    ssh $SSH_USER@$HOST"
echo "    cd $REMOTE_DIR"
echo "    docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f"
echo "    docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api"
echo ""
