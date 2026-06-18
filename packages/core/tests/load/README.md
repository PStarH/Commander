# Load Tests

This directory contains k6 load test scripts for Commander's HTTP API and agent runtime.

## Prerequisites

Install k6:

```bash
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D68
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6

# Windows
choco install k6
```

## Running Tests

### Start the server

```bash
# Start Commander HTTP server
npx tsx src/httpServer.ts
```

### Run load tests

```bash
# Run basic HTTP endpoint tests
k6 run tests/load/load-test.k6.js

# Run agent loop tests
k6 run tests/load/agent-loop.k6.js

# Custom configuration
K6_BASE_URL=http://localhost:3001 K6_VUS=20 K6_DURATION=120s k6 run tests/load/agent-loop.k6.js
```

## Environment Variables

| Variable      | Default                 | Description                         |
| ------------- | ----------------------- | ----------------------------------- |
| `K6_BASE_URL` | `http://127.0.0.1:3001` | Server base URL                     |
| `K6_API_KEY`  | (empty)                 | API key for authenticated endpoints |
| `K6_VUS`      | `10` / `5`              | Number of virtual users             |
| `K6_DURATION` | `30s` / `60s`           | Test duration                       |
| `K6_RAMP_UP`  | `10s`                   | Ramp up duration (agent-loop only)  |

## Test Scenarios

### load-test.k6.js

Basic HTTP endpoint tests:

- `/health` - Health check
- `/ready` - Readiness check
- `/metrics` - Metrics endpoint
- `/openapi.json` - OpenAPI spec

### agent-loop.k6.js

Agent runtime tests with weighted scenarios:

- Simple queries (30%)
- File read operations (20%)
- Web search operations (20%)
- Multi-tool operations (20%)
- Code execution (10%)

## Thresholds

Tests will fail if:

- 95th percentile latency exceeds 2s (agent-loop) or 500ms (basic)
- Error rate exceeds 5% (agent-loop) or 1% (basic)
- Agent loop latency exceeds 5s at p95
- Tool execution latency exceeds 1s at p95

## CI Integration

Add to `.github/workflows/ci.yml`:

```yaml
- name: Install k6
  run: brew install k6 # or appropriate for the OS

- name: Run load tests
  run: |
    k6 run --quiet tests/load/load-test.k6.js
    k6 run --quiet tests/load/agent-loop.k6.js
  env:
    K6_VUS: 5
    K6_DURATION: 30s
```
