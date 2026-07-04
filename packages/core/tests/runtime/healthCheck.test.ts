import { describe, it, expect } from 'vitest';
import { HealthCollector, type HealthSources } from '../../src/runtime/healthCheck';

describe('HealthCollector', () => {
  it('returns degraded when DLQ exceeds threshold', async () => {
    const sources: HealthSources = {
      getDLQInfo: () => ({
        totalEntries: 150,
        byCategory: [{ category: 'llm', count: 150 }],
      }),
    };
    const collector = new HealthCollector({ sources });
    const report = await collector.collect();

    expect(report.status).toBe('degraded');
    expect(report.checks.deadLetterQueue.status).toBe('degraded');
    expect(report.degradedComponents).toBeDefined();
    expect(report.degradedComponents).toContain('deadLetterQueue');
  });

  it('returns degraded when a circuit breaker is OPEN', async () => {
    const sources: HealthSources = {
      getCircuitBreakerInfo: () => ({ open: ['openai'], total: 3 }),
    };
    const collector = new HealthCollector({ sources });
    const report = await collector.collect();

    expect(report.status).toBe('degraded');
    expect(report.checks.circuitBreaker.status).toBe('degraded');
    expect(report.degradedComponents).toBeDefined();
    expect(report.degradedComponents).toContain('circuitBreaker');
  });

  it('returns unhealthy when no providers are available', async () => {
    const sources: HealthSources = {
      getProviderInfo: () => ({ available: 0, total: 3 }),
    };
    const collector = new HealthCollector({ sources });
    const report = await collector.collect();

    expect(report.status).toBe('unhealthy');
    expect(report.checks.providers.status).toBe('unhealthy');
    expect(report.degradedComponents).toBeDefined();
    expect(report.degradedComponents).toContain('providers');
  });

  it('marks wired checks healthy when their sources are normal', async () => {
    const sources: HealthSources = {
      getCircuitBreakerInfo: () => ({ open: [], total: 3 }),
      getDLQInfo: () => ({ totalEntries: 0, byCategory: [] }),
      getCompensationInfo: () => ({ pending: 0, compensated: 0 }),
      getEventBusInfo: () => ({ activeTopics: 1, subscriberCount: 2 }),
      getProviderInfo: () => ({ available: 3, total: 3 }),
    };
    const collector = new HealthCollector({ sources });
    const report = await collector.collect();

    expect(report.checks.circuitBreaker.status).toBe('healthy');
    expect(report.checks.deadLetterQueue.status).toBe('healthy');
    expect(report.checks.compensation.status).toBe('healthy');
    expect(report.checks.eventBus.status).toBe('healthy');
    expect(report.checks.providers.status).toBe('healthy');
    expect(report.degradedComponents).toBeDefined();
    // Memory/disk may push overall to degraded on constrained hosts; we only assert wired checks.
    expect(report.degradedComponents).not.toContain('circuitBreaker');
    expect(report.degradedComponents).not.toContain('deadLetterQueue');
    expect(report.degradedComponents).not.toContain('compensation');
    expect(report.degradedComponents).not.toContain('eventBus');
    expect(report.degradedComponents).not.toContain('providers');
  });

  it('falls back to "not wired" message when a source is absent', async () => {
    const collector = new HealthCollector({ sources: {} });
    const report = await collector.collect();

    expect(report.checks.circuitBreaker.message).toContain('not wired');
    expect(report.checks.providers.message).toContain('not wired');
    // Unwired checks themselves are healthy; overall status depends on memory/disk.
    expect(report.degradedComponents).toBeDefined();
    expect(report.degradedComponents).not.toContain('circuitBreaker');
    expect(report.degradedComponents).not.toContain('providers');
  });
});
