# Outcome Metrics Design (P0)

## 目标
- 为每个 **Project** 收集关键业务指标，帮助评估 agent 执行效果。
- 支持 **Outcome Metrics**（任务成功率、响应质量、延迟、成本、用户满意度）以及 **Governance Impact**（不同治理模式下的成功率）。
- 与现有 `WarRoomStore` 兼容，提供 REST API (`POST /api/metrics`, `GET /api/metrics`, `GET /api/metrics/aggregate`, `GET /api/metrics/dashboard`).

## 数据模型
```json
{
  "id": "metric-1723021056000-abc123",
  "projectId": "proj-xyz",
  "agentId": "agent-builder",
  "missionId": "mission-123",
  "taskSuccessRate": 0.92,          // 0‑1
  "responseQuality": 4.5,            // 1‑5 评分
  "latency": 120,                    // ms
  "costPerTask": 0.03,               // USD
  "userSatisfaction": 4.2,           // 可选 1‑5
  "errorRate": 0.01,                 // 0‑1
  "recordedAt": "2026-04-09T15:46:00.000Z"
}
```

### Aggregation Schema
```json
{
  "projectId": "proj-xyz",
  "timeWindow": "day",
  "startTime": "2026-04-08T00:00:00Z",
  "endTime": "2026-04-09T00:00:00Z",
  "metrics": {
    "taskSuccessRate": 0.88,
    "responseQuality": 4.1,
    "latency": 145,
    "costPerTask": 0.035,
    "userSatisfaction": 4.0,
    "errorRate": 0.015
  },
  "sampleSize": 42
}
```

## 实现路线 (P0)
1. **在 `WarRoomStore` 中添加 `metrics` 数组**，在构造函数调用 `loadMetrics()`，并在每次写入后 `persistMetrics()`。（已在代码中占位）
2. **实现四个核心方法**：
   - `recordMetrics(input: MetricsRecordInput): OutcomeMetrics`
   - `queryMetrics(input: MetricsQueryInput): OutcomeMetrics[]`
   - `aggregateMetrics(input: MetricsQueryInput): MetricsAggregation | null`
   - `getMetricsDashboard(projectId: string)` （返回当前、趋势、治理模式成功率）
3. **更新路由** (`apps/api/src/routes/metrics.ts`) 已经调用这些方法。
4. **在 `docs/` 中加入本说明文件**，便于团队了解指标体系。

## 下一步 (P1)
- 将 `recordMetrics` 与实际任务完成后自动调用（在 `orchestrator` 中插入调用点）。
- 为 `MetricsAggregation` 增加 **手动审批率、升级计数、恢复率** 等高级字段。
- 在前端仪表盘 UI 中展示趋势图与治理影响。

---
*此文件由 Commander 实施 Agent 根据最新研究笔记自动生成。*