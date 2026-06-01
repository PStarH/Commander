# Commander Deployment Runbook

## Quick Start

### Prerequisites
- Node.js >= 18.0.0
- pnpm >= 9.0.0
- Docker (optional, for containerized deployment)

### Local Development
```bash
# Install dependencies
pnpm install

# Start API server
cd apps/api && npx tsx src/index.ts

# Start Web GUI
cd apps/web && npx vite dev

# Run tests
pnpm test
```

### Docker Deployment
```bash
# Build and start
docker compose up -d

# Check health
curl http://localhost:4000/health

# View logs
docker compose logs -f api
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `4000` | API server port |
| `NODE_ENV` | No | `development` | Environment (development/production) |
| `CORS_ORIGINS` | No | `localhost:3000,4000,5173` | Comma-separated allowed origins |
| `API_RATE_LIMIT` | No | `120` | Requests per minute per IP |
| `COMMANDER_API_KEY` | Yes | - | API authentication key |
| `WARROOM_STORAGE` | No | `json` | Storage backend: `json` or `sqlite` |
| `OPENAI_API_KEY` | No | - | OpenAI API key for LLM |
| `OPENAI_BASE_URL` | No | - | Custom OpenAI-compatible endpoint |
| `OPENAI_MODEL` | No | - | Default model to use |

## Health Checks

### API Health
```bash
curl http://localhost:4000/health
```

Response:
```json
{
  "status": "healthy",
  "projectId": "project-war-room",
  "uptime": 3600,
  "memory": {
    "heapUsed": "150MB",
    "heapTotal": "512MB",
    "heapPercent": 29
  },
  "version": "0.2.0"
}
```

### System Status
```bash
curl http://localhost:4000/system/status
```

## Monitoring

### Logs
- API logs: `docker compose logs -f api`
- Web GUI logs: `docker compose logs -f web`

### Metrics
- Prometheus endpoint: `http://localhost:4000/api/runtime/metrics`
- Health endpoint: `http://localhost:4000/health`

### Alerts
- Rate limit exceeded: Check `X-RateLimit-Remaining` header
- Memory pressure: Check `heapPercent` in health response
- Circuit breaker open: Check logs for `CircuitBreaker` component

## Troubleshooting

### API Server Won't Start
1. Check port availability: `lsof -i :4000`
2. Check environment variables: `env | grep COMMANDER`
3. Check logs: `docker compose logs api`

### High Memory Usage
1. Check heap usage: `curl http://localhost:4000/health`
2. Restart if needed: `docker compose restart api`
3. Check for memory leaks: `node --inspect`

### Rate Limiting Issues
1. Check rate limit headers in response
2. Adjust `API_RATE_LIMIT` environment variable
3. Check for abusive clients in logs

### Database Issues
1. Check SQLite file permissions
2. Verify disk space: `df -h`
3. Check for corruption: `sqlite3 memory.db "PRAGMA integrity_check;"`

## Scaling

### Horizontal Scaling
- Use load balancer with session affinity
- Share state via external database (PostgreSQL)
- Use Redis for rate limiting

### Vertical Scaling
- Increase memory: `docker compose up -d --scale api=1`
- Monitor heap usage via health endpoint

## Security

### API Key Management
1. Generate secure key: `openssl rand -hex 32`
2. Set in environment: `COMMANDER_API_KEY=<key>`
3. Rotate regularly

### CORS Configuration
1. Set allowed origins: `CORS_ORIGINS=https://app.example.com,https://admin.example.com`
2. Never use `*` in production

### Rate Limiting
1. Set appropriate limits: `API_RATE_LIMIT=60`
2. Monitor via `X-RateLimit-*` headers
3. Adjust based on usage patterns

## Backup & Recovery

### Backup
```bash
# Backup SQLite database
cp .commander/memory.db .commander/memory.db.backup

# Backup configuration
cp .env .env.backup
```

### Recovery
```bash
# Restore from backup
cp .commander/memory.db.backup .commander/memory.db

# Restart services
docker compose restart
```

## Incident Response

### Severity Levels
- **P0**: Service down, data loss
- **P1**: Service degraded, partial functionality
- **P2**: Minor issue, workaround available
- **P3**: Cosmetic issue, no impact

### Response Procedure
1. Identify severity
2. Notify stakeholders
3. Investigate root cause
4. Implement fix
5. Verify resolution
6. Document incident
