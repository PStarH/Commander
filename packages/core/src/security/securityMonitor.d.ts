/**
 * SecurityMonitor — Continuous security health monitoring and anomaly detection.
 *
 * Monitors security events in real-time and detects:
 * - Burst patterns (many events in short window → possible attack)
 * - Severity escalation (low→medium→high→critical chain)
 * - Repeated failures from same source (brute force)
 * - New/unseen event types (zero-day detection)
 * - Credential access anomalies
 *
 * Integrates with SecurityAuditLogger via listener pattern.
 * Publishes alerts on MessageBus topic "security.alert".
 *
 * Usage:
 *   import { getSecurityMonitor } from './security/securityMonitor';
 *   const monitor = getSecurityMonitor();
 *   monitor.start(); // Begin monitoring
 *   monitor.getHealth(); // Get current security health status
 *   monitor.stop(); // Stop monitoring
 */
import { type SecurityEvent } from './securityAuditLogger';
export interface SecurityAlert {
    id: string;
    timestamp: string;
    level: 'warning' | 'critical';
    title: string;
    description: string;
    events: SecurityEvent[];
    recommendation: string;
}
export interface SecurityHealth {
    status: 'healthy' | 'elevated' | 'critical';
    activeAlerts: number;
    recentEvents: number;
    criticalEvents: number;
    eventRate: number;
    topThreats: Array<{
        type: string;
        count: number;
    }>;
    uptime: number;
}
interface MonitorConfig {
    /** Window size for burst detection (ms) */
    burstWindowMs: number;
    /** Threshold for burst alert */
    burstThreshold: number;
    /** Window for repeated failure detection (ms) */
    failureWindowMs: number;
    /** Threshold for repeated failures from same source */
    failureThreshold: number;
    /** Health check interval (ms) */
    healthCheckIntervalMs: number;
    /** Max active alerts */
    maxAlerts: number;
}
export declare class SecurityMonitor {
    private config;
    private alerts;
    private eventWindow;
    private sourceFailures;
    private seenTypes;
    private healthCheckTimer;
    private startTime;
    private running;
    private unsubscribe;
    constructor(config?: Partial<MonitorConfig>);
    /** Start monitoring security events. */
    start(): void;
    /** Stop monitoring. */
    stop(): void;
    /** Check if monitor is running. */
    isRunning(): boolean;
    /** Get current security health status. */
    getHealth(): SecurityHealth;
    /** Get active alerts. */
    getAlerts(limit?: number): SecurityAlert[];
    /** Dismiss an alert by ID. */
    dismissAlert(alertId: string): boolean;
    /** Clear all alerts. */
    clearAlerts(): void;
    /** Process a security event for anomaly detection. Called by the audit logger poller. */
    processEvent(event: SecurityEvent): void;
    private detectBurst;
    private detectRepeatedFailures;
    private detectSeverityEscalation;
    private raiseAlert;
    private analyzeRecentEvents;
    private cleanupOldEvents;
    private getRecentEvents;
}
export declare function getSecurityMonitor(): SecurityMonitor;
export declare function resetSecurityMonitor(): void;
export {};
//# sourceMappingURL=securityMonitor.d.ts.map