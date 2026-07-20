import type { KernelRepository } from '@commander/kernel';
import type { EffectBroker, EffectOutcomeQuerier } from '@commander/effect-broker';
import type { ActionAdapterRegistry } from '@commander/action-adapters';

export const MAX_RECONCILE_ATTEMPTS = 8;
const RECONCILE_BACKOFF_MS = 30_000;

export interface ReconciliationDaemonOptions {
  repository: KernelRepository;
  brokerFactory: (querier: EffectOutcomeQuerier) => EffectBroker;
  registry: ActionAdapterRegistry;
  pollIntervalMs: number;
  batchSize: number;
  actor: string;
}

export class ReconciliationDaemon {
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;

  constructor(private readonly options: ReconciliationDaemonOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.error('[reconciliation-daemon] tick failed:', err);
      });
    }, this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isHealthy(now = Date.now()): boolean {
    return now - this.lastTickAt < this.options.pollIntervalMs * 3;
  }

  async tick(): Promise<{
    claimed: number;
    completed: number;
    escalated: number;
    rescheduled: number;
  }> {
    this.lastTickAt = Date.now();
    let claimed: Awaited<ReturnType<KernelRepository['claimReconcileEffects']>>;
    try {
      claimed = await this.options.repository.claimReconcileEffects({
        limit: this.options.batchSize,
        now: new Date(),
      });
    } catch (err) {
      console.error('[reconciliation-daemon] tick failed:', err);
      return { claimed: 0, completed: 0, escalated: 0, rescheduled: 0 };
    }
    let completed = 0;
    let escalated = 0;
    let rescheduled = 0;
    for (const entry of claimed) {
      const { effect, claimToken } = entry;
      const querier = this.options.registry.outcomeQuerierFor(effect.type);
      if (!querier) {
        await this.options.repository.escalateReconcile({
          effectId: effect.id,
          tenantId: effect.tenantId,
          claimToken,
          reason: 'unregistered_adapter',
        });
        escalated += 1;
        continue;
      }
      const broker = this.options.brokerFactory(querier);
      try {
        const result = await broker.reconcileUnknown({
          effectId: effect.id,
          tenantId: effect.tenantId,
          actor: this.options.actor,
          querier,
        });
        if (result.status === 'ESCALATED') {
          if (effect.reconcileAttempts + 1 >= MAX_RECONCILE_ATTEMPTS) {
            await this.options.repository.escalateReconcile({
              effectId: effect.id,
              tenantId: effect.tenantId,
              claimToken,
              reason: result.reason ?? 'queryOutcome still UNKNOWN',
            });
            escalated += 1;
          } else {
            await this.options.repository.rescheduleReconcile({
              effectId: effect.id,
              tenantId: effect.tenantId,
              claimToken,
              reconcileAfter: new Date(Date.now() + RECONCILE_BACKOFF_MS).toISOString(),
              lastError: { code: 'RECONCILE_UNKNOWN', message: result.reason ?? 'UNKNOWN' },
            });
            rescheduled += 1;
          }
          continue;
        }
        await this.options.repository.releaseReconcileClaim(
          effect.id,
          effect.tenantId,
          claimToken,
        );
        completed += 1;
      } catch (error) {
        await this.options.repository.rescheduleReconcile({
          effectId: effect.id,
          tenantId: effect.tenantId,
          claimToken,
          reconcileAfter: new Date(Date.now() + RECONCILE_BACKOFF_MS).toISOString(),
          lastError: {
            code: 'RECONCILE_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        });
        rescheduled += 1;
      }
    }
    return { claimed: claimed.length, completed, escalated, rescheduled };
  }
}
