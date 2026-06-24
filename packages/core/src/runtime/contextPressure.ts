/**
 * Context Pressure — 4-tier context pressure detection and nudge generation.
 *
 * Mirrors MiMo-Code's overflow.ts pressureLevel() pattern:
 *   Level 0 (<50%): no action
 *   Level 1 (50-70%): soft trim nudge
 *   Level 2 (70-85%): hard prune + strip non-essential
 *   Level 3 (>=85%): memory flush nudge
 */

export type PressureLevel = 0 | 1 | 2 | 3;

export interface PressureState {
  level: PressureLevel;
  usageRatio: number;
  usableTokens: number;
  usedTokens: number;
  totalTokens: number;
  nudge?: string;
}

export interface PressureConfig {
  /** Output reserve cap (MiMo-Code OUTPUT_CAP). Default: 20000 */
  outputReserveCap: number;
  /** Thresholds for each pressure level (usageRatio bounds) */
  thresholds: {
    level1: number; // default 0.5
    level2: number; // default 0.7
    level3: number; // default 0.85
  };
}

const DEFAULT_CONFIG: PressureConfig = {
  outputReserveCap: 20_000,
  thresholds: {
    level1: 0.5,
    level2: 0.7,
    level3: 0.85,
  },
};

export class ContextPressure {
  private config: PressureConfig;

  constructor(config?: Partial<PressureConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Compute usable input window = model.limit.input - reserved.
   * Output reserve is capped at outputReserveCap to prevent models with
   * large output windows from strangling input context.
   */
  usable(modelInputLimit: number, reserved: number, outputReserve: number): number {
    const cappedOutput = Math.min(outputReserve, this.config.outputReserveCap);
    return Math.max(0, modelInputLimit - reserved - cappedOutput);
  }

  /**
   * Compute pressure level from usage ratio.
   * Mirrors MiMo-Code pressureLevel() exactly.
   */
  level(usageRatio: number): PressureLevel {
    if (usageRatio >= this.config.thresholds.level3) return 3;
    if (usageRatio >= this.config.thresholds.level2) return 2;
    if (usageRatio >= this.config.thresholds.level1) return 1;
    return 0;
  }

  /**
   * Full pressure state computation.
   */
  compute(
    totalTokens: number,
    modelInputLimit: number,
    reserved: number,
    outputReserve: number,
  ): PressureState {
    const usableTokens = this.usable(modelInputLimit, reserved, outputReserve);
    const usedTokens = Math.min(totalTokens, usableTokens);
    const usageRatio = usableTokens > 0 ? usedTokens / usableTokens : 0;
    const level = this.level(usageRatio);

    return {
      level,
      usageRatio,
      usableTokens,
      usedTokens,
      totalTokens,
      nudge: this.nudgeForLevel(level, usageRatio),
    };
  }

  /**
   * Generate a nudge message for the given pressure level.
   * These nudges are injected as synthetic user turns to guide the model.
   */
  nudgeForLevel(level: PressureLevel, usageRatio: number): string | undefined {
    switch (level) {
      case 0:
        return undefined;
      case 1:
        return `[System: Context usage is at ${(usageRatio * 100).toFixed(0)}%. Consider writing important findings to memory now.]`;
      case 2:
        return `[System: Context is filling up (${(usageRatio * 100).toFixed(0)}% used). Prioritize completing the current task and write key context to memory before continuing.]`;
      case 3:
        return `[System: Context pressure is critical (${(usageRatio * 100).toFixed(0)}% used). Focus only on the essential next step. Consider summarizing completed work.]`;
    }
  }

  /**
   * Check if compaction should be triggered at this pressure level.
   */
  shouldCompact(level: PressureLevel): boolean {
    return level >= 2;
  }

  /**
   * Check if memory flush should be suggested at this pressure level.
   */
  shouldFlushMemory(level: PressureLevel): boolean {
    return level >= 2;
  }

  /**
   * Check if strip-non-essential should run at this pressure level.
   */
  shouldStripNonEssential(level: PressureLevel): boolean {
    return level >= 2;
  }
}
