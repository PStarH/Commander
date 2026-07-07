"""Tests for newly added SDK endpoints (cost dashboard, OIDC, confidence, etc.)."""

from __future__ import annotations

import respx

from commander import (
    ApprovalAuditLog,
    ApprovalModeUpdated,
    ApprovalPatternRemoved,
    ApprovalPolicyResult,
    CommanderClient,
    ConflictDetectionResult,
    ConflictSummary,
    CostDashboardResponse,
    CostReport,
    MissionConfidenceAlerts,
    OIDCAuthResult,
    OIDCConfig,
    OIDCSettingsSaved,
    OutgoingWebhook,
    OutgoingWebhookDeliveries,
    OutgoingWebhookList,
    OutgoingWebhookStats,
    ReactiveConflictResult,
    ReplayResult,
    TeamAgentList,
    TeamReassignResult,
    TeamStatus,
    TeamWorkList,
    TimelineView,
    ToolPolicy,
    TraceTimelineNode,
    UnifiedApprovalConfig,
    ConfidenceReport,
    ConfidenceThresholdInfo,
)


class TestCostDashboard:
    async def test_cost_dashboard(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/cost/dashboard").respond(
            200,
            json={
                "timeRange": "7d",
                "summary": {
                    "totalCostUsd": 1.23,
                    "todayCostUsd": 0.45,
                    "averageCostPerTask": 0.1,
                    "cacheSavingsUsd": 0.05,
                    "totalTasks": 12,
                    "totalTokens": 50000,
                    "totalCalls": 30,
                    "peakCostHour": "2024-01-15T10:00:00.000Z",
                },
                "byModel": [
                    {
                        "model": "gpt-4o",
                        "provider": "openai",
                        "calls": 10,
                        "inputTokens": 1000,
                        "outputTokens": 500,
                        "cacheTokens": 100,
                        "costUsd": 0.75,
                        "percentage": 60.0,
                    }
                ],
                "byTool": [],
                "byUser": [],
                "trend": [],
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                dashboard = await client.cost_dashboard(time_range="7d")
            assert isinstance(dashboard, CostDashboardResponse)
            assert dashboard.summary.total_cost_usd == 1.23
            assert dashboard.by_model[0].model == "gpt-4o"


class TestOIDC:
    async def test_get_oidc_config(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/auth/oidc/config").respond(
            200,
            json={
                "enabled": True,
                "issuer": "https://example.com",
                "clientId": "client-1",
                "roleClaim": "roles",
                "adminRoles": ["admin"],
                "operatorRoles": ["operator"],
                "redirectUri": "http://localhost:5173/login",
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                config = await client.get_oidc_config()
            assert isinstance(config, OIDCConfig)
            assert config.enabled is True
            assert config.client_id == "client-1"

    async def test_exchange_oidc_token(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/auth/oidc/exchange").respond(
            200,
            json={
                "token": "access-token",
                "refreshToken": "refresh-token",
                "user": {
                    "id": "u1",
                    "username": "alice@example.com",
                    "email": "alice@example.com",
                    "role": "admin",
                    "createdAt": "2024-01-01T00:00:00Z",
                },
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.exchange_oidc_token("id-token")
            assert isinstance(result, OIDCAuthResult)
            assert result.token == "access-token"

    async def test_update_oidc_settings(self, mock_api: respx.MockRouter) -> None:
        mock_api.put("/api/auth/oidc/settings").respond(
            200,
            json={
                "status": "saved",
                "config": {
                    "enabled": True,
                    "issuer": "https://example.com",
                    "clientId": "client-1",
                    "redirectUri": "http://localhost:5173/login",
                },
            },
        )
        async with CommanderClient(api_key="test") as client:
            from commander import OIDCSettingsUpdate

            settings = OIDCSettingsUpdate(
                enabled=True,
                issuer="https://example.com",
                client_id="client-1",
                redirect_uri="http://localhost:5173/login",
            )
            async with mock_api:
                result = await client.update_oidc_settings(settings)
            assert isinstance(result, OIDCSettingsSaved)
            assert result.status == "saved"


class TestConfidence:
    async def test_get_mission_confidence(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/projects/p1/missions/m1/confidence").respond(
            200,
            json={
                "missionId": "m1",
                "totalDecisions": 10,
                "averageConfidence": 0.75,
                "distribution": {"low": 1, "medium": 2, "high": 4, "very-high": 3},
                "lowConfidenceActions": [],
                "trend": {
                    "direction": "stable",
                    "changeRate": 0.0,
                    "dataPoints": [],
                },
                "recommendations": [],
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                report = await client.get_mission_confidence("p1", "m1")
            assert isinstance(report, ConfidenceReport)
            assert report.mission_id == "m1"
            assert report.average_confidence == 0.75

    async def test_get_confidence_thresholds(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/confidence/thresholds").respond(
            200,
            json={
                "thresholds": {"low": 0.4, "warning": 0.6, "target": 0.8},
                "description": {
                    "low": "Below this threshold = critical alert",
                    "warning": "Below this threshold = warning",
                    "target": "Target confidence level",
                },
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                info = await client.get_confidence_thresholds()
            assert isinstance(info, ConfidenceThresholdInfo)
            assert info.thresholds.target == 0.8

    async def test_get_mission_confidence_alerts(
        self, mock_api: respx.MockRouter
    ) -> None:
        mock_api.get("/projects/p1/missions/m1/confidence/alerts").respond(
            200,
            json={
                "missionId": "m1",
                "alertCount": 1,
                "thresholds": {"low": 0.4, "warning": 0.6, "target": 0.8},
                "alerts": [
                    {
                        "actionId": "a1",
                        "missionId": "m1",
                        "agentId": "ag1",
                        "actionType": "tool_call",
                        "confidenceScore": 0.3,
                        "severity": "high",
                        "rationale": "Low confidence",
                    }
                ],
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                alerts = await client.get_mission_confidence_alerts("p1", "m1")
            assert isinstance(alerts, MissionConfidenceAlerts)
            assert alerts.alert_count == 1


class TestConflictDetection:
    async def test_proactive_conflict_check(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/projects/p1/conflict-detection/proactive").respond(
            200,
            json={
                "hasConflict": False,
                "reasoning": "No conflicts detected in proactive check",
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.proactive_conflict_check(
                    "p1", "ag1", {"agentId": "ag1", "actionType": "read"}
                )
            assert isinstance(result, ConflictDetectionResult)
            assert result.has_conflict is False

    async def test_get_conflict_summary(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/projects/p1/conflict-detection/summary").respond(
            200,
            json={
                "agentWorkloads": {"ag1": 2},
                "potentialConflicts": [],
                "recommendations": ["No immediate conflict risks detected"],
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                summary = await client.get_conflict_summary("p1")
            assert isinstance(summary, ConflictSummary)
            assert summary.agent_workloads["ag1"] == 2

    async def test_reactive_conflict_monitor(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/projects/p1/conflict-detection/reactive").respond(
            200,
            json={"conflicts": [], "summary": []},
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.reactive_conflict_monitor("p1", [])
            assert isinstance(result, ReactiveConflictResult)


class TestTeam:
    async def test_get_team_status(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/teams/run_001/status").respond(
            200,
            json={
                "runId": "run_001",
                "total": 5,
                "pending": 1,
                "claimed": 1,
                "running": 1,
                "completed": 1,
                "failed": 1,
                "reassigned": 0,
                "byAgent": {},
                "pendingByAgent": {},
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                status = await client.get_team_status("run_001")
            assert isinstance(status, TeamStatus)
            assert status.run_id == "run_001"

    async def test_list_team_work(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/teams/run_001/work").respond(
            200,
            json={"runId": "run_001", "items": [], "total": 0},
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                work = await client.list_team_work("run_001")
            assert isinstance(work, TeamWorkList)

    async def test_list_team_agents(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/teams/run_001/agents").respond(
            200,
            json={"runId": "run_001", "agents": [], "total": 0},
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                agents = await client.list_team_agents("run_001")
            assert isinstance(agents, TeamAgentList)

    async def test_reassign_team_work(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/teams/run_001/reassign").respond(
            200,
            json={"status": "reassigned", "workId": "w1"},
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.reassign_team_work("run_001", "w1")
            assert isinstance(result, TeamReassignResult)
            assert result.status == "reassigned"


class TestApprovalConfig:
    async def test_get_approval_config(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/approval/config").respond(
            200,
            json={
                "sandboxMode": "auto-edit",
                "sandboxModeDescription": "File edits auto-approved",
                "toolPolicies": [
                    {
                        "pattern": "shell_execute",
                        "level": "manual",
                        "riskLevel": "critical",
                        "description": "Shell command execution requires manual approval",
                    }
                ],
                "failClosed": True,
                "lastUpdated": "2024-01-01T00:00:00Z",
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                config = await client.get_approval_config()
            assert isinstance(config, UnifiedApprovalConfig)
            assert config.fail_closed is True

    async def test_update_approval_sandbox_mode(
        self, mock_api: respx.MockRouter
    ) -> None:
        mock_api.put("/api/approval/sandbox-mode").respond(
            200,
            json={
                "status": "updated",
                "mode": "read-only",
                "description": "Agent can only read",
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.update_approval_sandbox_mode("read-only")
            assert isinstance(result, ApprovalModeUpdated)
            assert result.mode == "read-only"

    async def test_add_approval_policy(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/approval/policy").respond(
            201,
            json={
                "status": "added",
                "policy": {
                    "pattern": "custom_tool",
                    "level": "manual",
                    "riskLevel": "high",
                    "description": "Custom tool",
                },
            },
        )
        async with CommanderClient(api_key="test") as client:
            policy = ToolPolicy(
                pattern="custom_tool",
                level="manual",
                risk_level="high",
                description="Custom tool",
            )
            async with mock_api:
                result = await client.add_approval_policy(policy)
            assert isinstance(result, ApprovalPolicyResult)
            assert result.status == "added"

    async def test_delete_approval_policy(self, mock_api: respx.MockRouter) -> None:
        mock_api.delete("/api/approval/policy/custom_tool").respond(
            200,
            json={"status": "removed", "pattern": "custom_tool"},
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.delete_approval_policy("custom_tool")
            assert isinstance(result, ApprovalPatternRemoved)

    async def test_get_approval_audit_log(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/approval/audit-log").respond(
            200,
            json={"entries": [], "total": 0},
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                log = await client.get_approval_audit_log()
            assert isinstance(log, ApprovalAuditLog)


class TestOutgoingWebhooks:
    async def test_list_outgoing_webhooks(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/outgoing-webhooks").respond(
            200,
            json={
                "webhooks": [
                    {
                        "id": "wh1",
                        "url": "https://example.com/webhook",
                        "events": ["run.completed"],
                        "enabled": True,
                        "createdAt": "2024-01-01T00:00:00Z",
                    }
                ]
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.list_outgoing_webhooks()
            assert isinstance(result, OutgoingWebhookList)
            assert len(result.webhooks) == 1

    async def test_create_outgoing_webhook(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/outgoing-webhooks").respond(
            201,
            json={
                "webhook": {
                    "id": "wh1",
                    "url": "https://example.com/webhook",
                    "events": ["run.completed"],
                    "enabled": True,
                }
            },
        )
        async with CommanderClient(api_key="test") as client:
            from commander import OutgoingWebhookCreate

            webhook = OutgoingWebhookCreate(
                url="https://example.com/webhook", events=["run.completed"]
            )
            async with mock_api:
                result = await client.create_outgoing_webhook(webhook)
            assert isinstance(result, OutgoingWebhook)
            assert result.id == "wh1"

    async def test_get_outgoing_webhook_stats(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/outgoing-webhooks/stats").respond(
            200,
            json={
                "totalWebhooks": 1,
                "totalDeliveries": 10,
                "successfulDeliveries": 9,
                "failedDeliveries": 1,
                "pendingDeliveries": 0,
                "totalRetries": 0,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                stats = await client.get_outgoing_webhook_stats()
            assert isinstance(stats, OutgoingWebhookStats)
            assert stats.total_webhooks == 1

    async def test_get_outgoing_webhook_deliveries(
        self, mock_api: respx.MockRouter
    ) -> None:
        mock_api.get("/api/outgoing-webhooks/wh1/deliveries").respond(
            200,
            json={"deliveries": [], "total": 0},
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.get_outgoing_webhook_deliveries("wh1")
            assert isinstance(result, OutgoingWebhookDeliveries)


class TestObservability:
    async def test_get_trace_timeline(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/v1/observability/runs/run_001/timeline").respond(
            200,
            json={
                "runId": "run_001",
                "traceId": "t1",
                "agentId": "ag1",
                "startedAt": "2024-01-01T00:00:00Z",
                "summary": {
                    "totalSpans": 5,
                    "totalTokens": 1000,
                    "totalCostUsd": 0.01,
                    "durationMs": 2000,
                    "status": "SUCCESS",
                },
                "timeline": [],
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                view = await client.get_trace_timeline("run_001")
            assert isinstance(view, TimelineView)
            assert view.run_id == "run_001"

    async def test_get_trace_cost_report(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/v1/observability/runs/run_001/cost").respond(
            200,
            json={
                "runId": "run_001",
                "traceId": "t1",
                "total": {"tokens": 1000, "costUsd": 0.01, "calls": 5},
                "byModel": [],
                "byProvider": [],
                "byAgent": [],
                "byDay": [],
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                report = await client.get_trace_cost_report("run_001")
            assert isinstance(report, CostReport)
            assert report.total.tokens == 1000

    async def test_get_trace_span(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/v1/observability/runs/run_001/spans/span_1").respond(
            200,
            json={
                "spanId": "span_1",
                "traceId": "t1",
                "runId": "run_001",
                "agentId": "ag1",
                "type": "llm_call",
                "name": "generate",
                "status": "ok",
                "durationMs": 500,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                span = await client.get_trace_span("run_001", "span_1")
            assert isinstance(span, TraceTimelineNode)
            assert span.span_id == "span_1"

    async def test_replay_run(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/v1/observability/runs/run_001/replay").respond(
            200,
            json={
                "runId": "run_001",
                "traceId": "t1",
                "originalSummary": {
                    "totalSpans": 5,
                    "totalTokens": 1000,
                    "totalCostUsd": 0.01,
                    "durationMs": 2000,
                    "status": "SUCCESS",
                },
                "replaySummary": {
                    "totalSpans": 5,
                    "totalTokens": 1000,
                    "totalCostUsd": 0.01,
                    "durationMs": 2100,
                    "status": "SUCCESS",
                },
                "diff": {},
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.replay_run("run_001")
            assert isinstance(result, ReplayResult)
            assert result.run_id == "run_001"
