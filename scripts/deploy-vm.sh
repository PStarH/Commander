#!/bin/bash
# =============================================================================
# Commander — VM Deployment Script
#
# Deploys a PRE-BUILT, digest-pinned image set to a Linux VM with Docker +
# Docker Compose. This script does not build anything: the candidate must have
# been built once in a trusted, complete-source environment and published.
#
# Contract (enforced by scripts/deploy-vm-contract.test.ts):
#   * production-only compose file (docker-compose.prod.yml). The development
#     base compose file is never merged in — it carries `build:` stanzas, which
#     is what previously forced a remote `--build` from an incomplete source
#     tree.
#   * no remote build: `up -d --no-build` only.
#   * the host key must ALREADY be in known_hosts (StrictHostKeyChecking=yes).
#     `accept-new` is not offered.
#   * a real environment file is required. `.env.example` is not production
#     configuration and is rejected.
#   * the environment file is uploaded to a FIXED staging path created mode 0600
#     before the secret is transferred, then moved into place. The operator's
#     filename is never interpolated into a remote shell command.
#   * readiness is observed INSIDE the api container (`/ready`, HTTP 200). The
#     production compose file publishes no host port for the API, so a host-side
#     probe of /health can never succeed.
#   * any failed stage exits non-zero and the success banner is never printed.
#
# Prerequisites on target VM:
#   - Docker Engine 24+, Docker Compose v2
#
# Usage:
#   ./scripts/deploy-vm.sh <host> --env-file <path> [options]
#
# Options:
#   --user <user>          SSH user (default: root)
#   --key <path>           SSH private key
#   --env-file <path>      Production env file (required)
#   --known-hosts <path>   known_hosts file (default: ~/.ssh/known_hosts)
#   --install              Also apply docker-compose.prod.install.yml
#   --port <port>          API port probed inside the api container (default: 4000)
#   --web-url <url>        Optional public web origin to probe (must return 200)
#   --deadline <seconds>   Total readiness deadline (default: 180)
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
die()  { echo -e "${RED}  ✗ $1${NC}" >&2; exit 1; }

usage() {
  # Print the leading comment block only (lines starting with `#`). A fixed
  # line range used to leak the first shell statement into `--help` output.
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

# ── Args ──────────────────────────────────────────────────────────────────────
HOST=""
SSH_USER="root"
SSH_KEY=""
ENV_FILE=""
KNOWN_HOSTS="${HOME}/.ssh/known_hosts"
USE_INSTALL_OVERLAY=false
API_PORT="4000"
WEB_URL=""
DEADLINE=180

while [[ $# -gt 0 ]]; do
  case $1 in
    --user)        [[ $# -ge 2 ]] || die "--user requires a value"; SSH_USER="$2"; shift 2 ;;
    --key)         [[ $# -ge 2 ]] || die "--key requires a value"; SSH_KEY="$2"; shift 2 ;;
    --env-file)    [[ $# -ge 2 ]] || die "--env-file requires a value"; ENV_FILE="$2"; shift 2 ;;
    --known-hosts) [[ $# -ge 2 ]] || die "--known-hosts requires a value"; KNOWN_HOSTS="$2"; shift 2 ;;
    --install)     USE_INSTALL_OVERLAY=true; shift ;;
    --port)        [[ $# -ge 2 ]] || die "--port requires a value"; API_PORT="$2"; shift 2 ;;
    --web-url)     [[ $# -ge 2 ]] || die "--web-url requires a value"; WEB_URL="$2"; shift 2 ;;
    --deadline)    [[ $# -ge 2 ]] || die "--deadline requires a value"; DEADLINE="$2"; shift 2 ;;
    --help|-h)     usage; exit 0 ;;
    -*)            die "Unknown option: $1" ;;
    *)
      if [[ -n "$HOST" ]]; then die "Unexpected argument: $1"; fi
      HOST="$1"; shift ;;
  esac
done

[[ -n "$HOST" ]] || { usage; die "Usage: $0 <host> --env-file <path> [options]"; }

# ── Input validation (before anything is sent anywhere) ───────────────────────
[[ "$HOST" =~ ^[A-Za-z0-9._-]+$ ]] || die "Invalid host: $HOST"
[[ "$SSH_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Invalid ssh user: $SSH_USER"
[[ "$API_PORT" =~ ^[0-9]+$ ]] || die "Invalid port: $API_PORT"
[[ "$DEADLINE" =~ ^[0-9]+$ ]] || die "Invalid deadline: $DEADLINE"
[[ -n "$ENV_FILE" ]] || die "--env-file is required: .env.example is not production configuration"
[[ -f "$ENV_FILE" ]] || die "Env file not found: $ENV_FILE"
if [[ "$(basename "$ENV_FILE")" == ".env.example" ]]; then
  die "Refusing to deploy .env.example as production configuration"
fi
[[ -s "$ENV_FILE" ]] || die "Env file is empty: $ENV_FILE"
[[ -f "$KNOWN_HOSTS" ]] || die "known_hosts not found at $KNOWN_HOSTS — add the host key first (ssh-keyscan is not a substitute for verification)"
if [[ -n "$SSH_KEY" ]]; then
  [[ -f "$SSH_KEY" ]] || die "SSH key not found: $SSH_KEY"
fi

# ── Transport (overridable so the contract test can substitute a fake) ────────
# The DEFAULT is resolved through PATH: `ssh`/`scp` are bare names, not absolute
# paths, so validating the default with the same rule as an override rejected
# every ordinary deployment. A caller-supplied override is still validated
# strictly — it must be an absolute, executable path.
resolve_transport() {
  local name="$1" override="${2:-}" resolved
  if [[ -n "$override" ]]; then
    [[ "$override" == /* ]] || die "$name override must be an absolute path: $override"
    [[ -x "$override" ]] || die "$name override is not executable: $override"
    printf '%s\n' "$override"
    return 0
  fi
  resolved="$(command -v "$name" || true)"
  [[ -n "$resolved" ]] || die "$name not found on PATH; install it or set an absolute override"
  [[ "$resolved" == /* ]] || die "Resolved $name is not an absolute path: $resolved"
  printf '%s\n' "$resolved"
}

SSH_BIN="$(resolve_transport ssh "${COMMANDER_DEPLOY_SSH_BIN:-}")"
SCP_BIN="$(resolve_transport scp "${COMMANDER_DEPLOY_SCP_BIN:-}")"

SSH_OPTS=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS" -o ConnectTimeout=10)
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY")
fi

ssh_run() { "$SSH_BIN" "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "$@"; }
scp_put() { "$SCP_BIN" "${SSH_OPTS[@]}" "$@" "$SSH_USER@$HOST:$REMOTE_DIR/"; }
# Upload to an explicit remote path. Used for the environment file, whose
# destination must not be derived from the operator's filename.
scp_put_to() { "$SCP_BIN" "${SSH_OPTS[@]}" "$1" "$SSH_USER@$HOST:$2"; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR="/opt/commander"
PROD_COMPOSE="docker-compose.prod.yml"
INSTALL_COMPOSE="docker-compose.prod.install.yml"

COMPOSE_ARGS=(-f "$PROD_COMPOSE")
if $USE_INSTALL_OVERLAY; then
  COMPOSE_ARGS+=(-f "$INSTALL_COMPOSE")
fi
COMPOSE_CMD="docker compose ${COMPOSE_ARGS[*]}"

# ── Prerequisites ─────────────────────────────────────────────────────────────
log "Deploying Commander to ${GREEN}$HOST${NC} as ${GREEN}$SSH_USER${NC} (pre-built images, no remote build)"

log "Checking remote prerequisites..."
ssh_run "docker --version >/dev/null && docker compose version >/dev/null" \
  || die "Remote prerequisites missing on $HOST (need docker + docker compose v2)"
ok "Docker + Docker Compose ready"

# ── Upload artifacts ──────────────────────────────────────────────────────────
log "Preparing remote directory..."
ssh_run "mkdir -p '$REMOTE_DIR'" || die "Could not create $REMOTE_DIR on $HOST"

log "Transferring deployment artifacts..."
for file in "$PROD_COMPOSE" "$INSTALL_COMPOSE"; do
  [[ -f "$PROJECT_ROOT/$file" ]] || die "Missing artifact: $file"
  scp_put "$PROJECT_ROOT/$file" || die "Upload failed: $file"
done

# The environment file goes to a FIXED staging path, never to a path derived
# from the operator's filename:
#   * `mv $REMOTE_DIR/$(basename "$ENV_FILE") $REMOTE_DIR/.env` is a no-op that
#     FAILS when the operator's file is already called `.env` ("are the same
#     file"), and it interpolates an operator-controlled name into a remote
#     shell command.
#   * scp creates a new file with the source's mode, so a world-readable .env
#     could exist for the whole transfer. The staging file is created 0600
#     first, so the secret never lands in a permissive file.
ENV_STAGING_PATH="$REMOTE_DIR/.env.incoming"
ssh_run "umask 077 && : > '$ENV_STAGING_PATH' && chmod 600 '$ENV_STAGING_PATH'" \
  || die "Could not prepare $ENV_STAGING_PATH on $HOST"
scp_put_to "$ENV_FILE" "$ENV_STAGING_PATH" || die "Upload failed: $ENV_FILE"
ssh_run "chmod 600 '$ENV_STAGING_PATH' && mv -f '$ENV_STAGING_PATH' '$REMOTE_DIR/.env'" \
  || die "Could not install the remote .env"
ok "Artifacts transferred"

# ── Deploy (pull + up, never build) ───────────────────────────────────────────
# The production compose file references every image through a required
# COMMANDER_*_IMAGE variable, so a missing or mutable image reference fails here
# rather than silently building from whatever source happens to be on the VM.
log "Pulling the pinned image set..."
ssh_run "cd '$REMOTE_DIR' && $COMPOSE_CMD config >/dev/null" \
  || die "Production compose configuration is invalid or an image variable is unset"
ssh_run "cd '$REMOTE_DIR' && $COMPOSE_CMD pull" || die "Image pull failed — refusing to build on the remote host"

log "Starting services (no remote build)..."
ssh_run "cd '$REMOTE_DIR' && $COMPOSE_CMD up -d --no-build --remove-orphans" \
  || die "Service start failed"
ok "Containers started"

# ── Readiness (blocking) ──────────────────────────────────────────────────────
# The probe runs INSIDE the api container. docker-compose.prod.yml publishes no
# host port for the API (only the 9443 tenant-authority proof port is exposed on
# the compose network), so a host-side `curl http://localhost:${API_PORT}/health`
# could never succeed — the previous check failed correct deployments.
#
# `/ready` is the readiness gate: HTTP 200 only when the hard dependency probes
# pass, 503 otherwise. `/health` is liveness and its `status=ok` body is not a
# readiness signal. The fetch is bounded by an AbortController so a hung socket
# cannot stall the deadline loop.
READY_PROBE_JS="const ac=new AbortController();const t=setTimeout(()=>ac.abort(),3000);fetch(\"http://127.0.0.1:${API_PORT}/ready\",{signal:ac.signal}).then(r=>{clearTimeout(t);process.exit(r.status===200?0:1)}).catch(()=>process.exit(1));"

readiness_probe() {
  ssh_run "cd '$REMOTE_DIR' && $COMPOSE_CMD exec -T api node -e '$READY_PROBE_JS'" >/dev/null 2>&1
}

log "Waiting for readiness (deadline ${DEADLINE}s)..."
deadline_at=$(( $(date +%s) + DEADLINE ))
ready=false
while [[ $(date +%s) -lt $deadline_at ]]; do
  if readiness_probe; then
    ready=true
    break
  fi
  sleep 3
done

$ready || die "Readiness FAILED: /ready did not return HTTP 200 inside the api container within ${DEADLINE}s. Deployment is NOT complete."
ok "API readiness passed (/ready returned HTTP 200 inside the api container)"

# ── Optional public web probe ─────────────────────────────────────────────────
# Only when an operator names a web origin. There is no web service in the
# production compose file, so probing a port that may not exist is not a
# readiness condition.
if [[ -n "$WEB_URL" ]]; then
  web_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$WEB_URL" || true)"
  [[ "$web_code" == "200" ]] || die "Web origin $WEB_URL returned HTTP ${web_code:-000}, expected 200"
  ok "Web origin returned HTTP 200"
fi

# ── Summary (only reached when every stage passed) ────────────────────────────
echo ""
log "${GREEN}══════════════════════════════════════════════════════════${NC}"
log "${GREEN}  Commander deployed and verified on $HOST${NC}"
log "${GREEN}══════════════════════════════════════════════════════════${NC}"
echo ""
# The API is NOT published on a host port by the production compose file, so
# there is no host URL to advertise. Readiness was observed on the compose
# network instead.
echo "  API:      reachable on the compose network as http://api:${API_PORT}/ (not published on the host)"
echo "  Readiness was verified inside the api container: GET /ready → HTTP 200"
echo ""
echo "  Manage:"
echo "    ssh $SSH_USER@$HOST"
echo "    cd $REMOTE_DIR"
echo "    $COMPOSE_CMD logs -f"
echo "    $COMPOSE_CMD exec api node -e 'fetch(\"http://127.0.0.1:${API_PORT}/ready\").then(r=>console.log(r.status))'"
echo ""
warn "This script deployed pre-built images only. It did not run a migration or a"
warn "tenant lifecycle operation; use the compose lifecycle owner for those."
