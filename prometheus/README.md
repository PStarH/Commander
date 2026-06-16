# Commander Prometheus Integration

This directory contains Prometheus configuration for monitoring the Commander compensation subsystem.

## Files

- [`alert-rules.yml`](./alert-rules.yml) — Alerting rules for sustained compensation failures, exhaustion, and anomaly detection
- [`compensation-dashboard.json`](./compensation-dashboard.json) — Grafana dashboard (v9+) visualizing all compensation metrics with stat cards, time series, pie charts, and per-tool tables

## Setup

1. **Configure Prometheus to scrape Commander's `/metrics` endpoint:**

   ```yaml
   # prometheus.yml
   scrape_configs:
     - job_name: 'commander'
       scrape_interval: 30s
       metrics_path: '/metrics'
       scheme: http
       static_configs:
         - targets: ['localhost:3001']
       # If auth is enabled, add the Bearer token:
       authorization:
         credentials: 'your-commander-api-key'
   ```

2. **Add the alert rules to your Prometheus config:**

   ```yaml
   rule_files:
     - /etc/prometheus/commander-alert-rules.yml
   ```

   Or copy the file to your Prometheus rules directory.

3. **Reload Prometheus:**

   ```bash
   curl -X POST http://localhost:9090/-/reload
   ```

## Available Metrics

See [packages/core/src/runtime/metricsCollector.ts](../packages/core/src/runtime/metricsCollector.ts) for the full list of exported metrics.

| Metric                       | Type    | Labels            | Description                              |
| ---------------------------- | ------- | ----------------- | ---------------------------------------- |
| `compensation_planned_total` | Counter | `tool`, `risk`    | Plans created when a mutation tool fails |
| `compensation_steps_total`   | Counter | `tool`, `status`  | Individual compensation steps executed   |
| `compensation_total`         | Counter | `tool`, `outcome` | Compensation action outcomes             |

## Alert Severity Levels

| Severity   | Meaning                             | Response         |
| ---------- | ----------------------------------- | ---------------- |
| `info`     | Informational, no action required   | Monitor          |
| `warning`  | Degraded behavior, investigate soon | Check dashboard  |
| `critical` | Manual intervention required        | Immediate action |

## Dashboard

The compensation dashboard is available at `http://localhost:3001/dashboard/compensation` when the HTTP server is running.
