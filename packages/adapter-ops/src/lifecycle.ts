export interface AdapterOpsDaemonLifecycle {
  start(): void;
  stop(options?: { drain?: boolean }): Promise<void>;
}

export interface AdapterOpsRuntimeWiring {
  reconciliation: AdapterOpsDaemonLifecycle;
  compensation: AdapterOpsDaemonLifecycle;
  safeStop(reason: string): Promise<void>;
  close(): Promise<void>;
}

export interface AdapterOpsHealthLifecycle {
  close(): Promise<void>;
}

async function closeRuntimeResources(
  wiring: AdapterOpsRuntimeWiring,
  health?: AdapterOpsHealthLifecycle,
  reason = 'shutdown',
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await wiring.safeStop(reason);
  } catch (error) {
    errors.push(error);
  }
  if (health) {
    try {
      await health.close();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await wiring.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      errors[0] instanceof Error ? errors[0].message : 'adapter-ops shutdown failed',
    );
  }
}

export async function startAdapterOpsRuntime(options: {
  wiring: AdapterOpsRuntimeWiring;
  startHealth: () => Promise<AdapterOpsHealthLifecycle>;
}): Promise<{ shutdown(): Promise<void> }> {
  options.wiring.reconciliation.start();
  options.wiring.compensation.start();
  let health: AdapterOpsHealthLifecycle;
  try {
    health = await options.startHealth();
  } catch (error) {
    try {
      await closeRuntimeResources(options.wiring, undefined, 'health_start_failed');
    } catch {
      // Preserve the bind/start failure as the primary startup cause.
    }
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return {
    shutdown: () => {
      stopping ??= closeRuntimeResources(options.wiring, health);
      return stopping;
    },
  };
}
