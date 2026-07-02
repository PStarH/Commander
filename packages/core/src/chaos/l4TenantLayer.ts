// packages/core/src/chaos/l4TenantLayer.ts
export interface TenantContext {
  tenantId: string;
}

export interface L4FaultConfig {
  tenantId: string;
  faultType: string;
}

export interface CrossTenantAccess {
  from: string;
  to: string;
}

export interface BlastRadiusReport {
  armedTenants: string[];
  crossTenantLeaks: number;
}

export class L4TenantLayer {
  private faults: L4FaultConfig[] = [];
  private accesses: CrossTenantAccess[] = [];
  private monitor?: (access: CrossTenantAccess) => void;

  arm(fault: L4FaultConfig): void {
    this.faults.push(fault);
  }

  disarm(): void {
    this.faults = [];
    this.accesses = [];
  }

  shouldApply(ctx: TenantContext): boolean {
    return this.faults.some((f) => f.tenantId === ctx.tenantId);
  }

  recordAccess(access: CrossTenantAccess): void {
    this.accesses.push(access);
    this.monitor?.(access);
  }

  onCrossTenantAccess(callback: (access: CrossTenantAccess) => void): void {
    this.monitor = callback;
  }

  simulateBlastRadius(): BlastRadiusReport {
    return {
      armedTenants: Array.from(new Set(this.faults.map((f) => f.tenantId))),
      crossTenantLeaks: this.accesses.length,
    };
  }
}
