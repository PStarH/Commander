/**
 * CycleDetector — tool call cycle detection
 *
 * Detects and interrupts repeating tool-call patterns to prevent infinite loops.
 * Inspired by OpenClaw's loop-detection design, but more adaptive:
 * - Detects consecutive identical tool calls (same tool + same args)
 * - Detects alternating loops (A→B→A→B)
 * - Detects slow-drift loops (repeated calls with small parameter changes)
 * - Provides structured feedback so the model knows why execution was stopped
 */
interface CycleDetectorConfig {
    /** 最大允许的相同连续工具调用次数 (默认: 3) */
    maxConsecutiveSameTool: number;
    /** 检测交替模式的窗口大小 (默认: 6) */
    alternatingPatternWindow: number;
    /** 漂移检测：允许参数微调的最大次数 (默认: 5) */
    maxDriftIterations: number;
    /** 漂移追踪器最大条目数 (默认: 200) */
    maxDriftEntries: number;
}
export type CycleDetectionResult = {
    detected: false;
} | {
    detected: true;
    type: 'consecutive' | 'alternating' | 'drift' | 'semantic_stagnation';
    description: string;
    advice: string;
    similarity?: number;
};
export declare class CycleDetector {
    private config;
    private history;
    private historyHead;
    private historyCount;
    private readonly maxHistory;
    private consecutiveSameToolCount;
    private lastToolName;
    private lastDiffParamValue;
    private lastStepNumber;
    private driftTracker;
    private outputHistory;
    private readonly maxOutputHistory;
    constructor(config?: Partial<CycleDetectorConfig>);
    /**
     * 检查新工具调用是否构成循环
     */
    check(toolName: string, args: Record<string, unknown>, stepNumber: number): CycleDetectionResult;
    checkOutput(output: string): CycleDetectionResult;
    private static extractFingerprint;
    private static semanticSimilarity;
    /**
     * 重置检测器状态（用于新任务）
     */
    reset(): void;
    private detectConsecutive;
    private detectAlternating;
    private detectDrift;
    /**
     * 获取调试信息
     */
    getDebugInfo(): {
        historyLength: number;
        consecutiveSameToolCount: number;
        lastToolName: string | null;
        driftEntries: {
            [k: string]: number;
        };
    };
}
export {};
//# sourceMappingURL=cycleDetector.d.ts.map